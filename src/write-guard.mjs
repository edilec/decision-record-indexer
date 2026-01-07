import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * Three distinct holes, and each needs its own check because no one of them
 * catches the others:
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help --
 *    it resolves the link, and resolving is precisely the dangerous act. The
 *    link is refused on sight, by `lstat`, before anything is opened. This also
 *    covers a link aimed at a path that does not exist yet, which otherwise
 *    creates a file outside the root.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and checked against the root rather than compared lexically.
 *    Lexical comparison passes for `root/link/out` where `link` leaves the root.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    it, so realpath and string comparison both say it is a different file. It
 *    is the same file. Only device plus inode sees that.
 *
 * Measured on this tool before the guard was wired in, each exiting 0 and
 * reporting "index written": a symbolic link at `--index` replaced an 11-byte
 * file outside the archive with a 5 kB index, a link aimed at a path that did
 * not exist created that file outside the archive, a symlinked parent did the
 * same one level up, and a hard link to a decision record overwrote the record
 * itself -- the one thing this tool promises never to write to.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--index', rootLabel = '--index-root' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the output wherever `
      + 'the link points, which is not the path you named, so it is refused. '
      + 'Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside the permitted root. `
        + 'A link or a ".." segment on the way there does not widen it. '
        + `Pass ${rootLabel} to declare the tree the index may be written into.`,
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input)
    } catch {
      continue
    }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as an input (they share device ${existing.dev} and `
        + `inode ${existing.ino}, so a hard link does not make them different files). `
        + 'This tool never rewrites what it reads.',
      )
    }
  }
  return target
}
