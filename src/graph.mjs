/**
 * The supersession graph.
 *
 * An edge points from the record that supersedes to the record it replaces, so
 * following edges forward walks from an old decision towards the current one.
 * Both `supersedes` and `superseded-by` produce edges, because a repository
 * that only ever writes one direction is still a real repository -- but the
 * two directions are cross-checked, since a one-sided declaration is how a
 * supersession quietly disappears.
 *
 * Two failures here are not opinions: a cycle means the history claims a
 * decision replaced itself, and a reference to a record that does not exist
 * means the history points at nothing. Both are reported as errors.
 */

import { byCodeUnit } from './parse.mjs'

/**
 * Map-key separator. Built from a code point rather than written literally so
 * the source file never carries a control character of its own.
 */
const SEP = String.fromCharCode(0)

/**
 * Build the edge set.
 *
 * `records` must already be sorted by id. Every edge remembers each place it
 * was declared, so a finding can name the exact file and field that produced
 * it rather than a graph node with no address.
 */
export function buildEdges(records) {
  const declarations = []
  for (const record of records) {
    for (let index = 0; index < record.supersedes.length; index += 1) {
      declarations.push({
        from: record.id,
        to: record.supersedes[index],
        file: record.file,
        pointer: `/supersedes/${index}`,
        field: 'supersedes',
        declaredBy: record.id,
      })
    }
    for (let index = 0; index < record.supersededBy.length; index += 1) {
      declarations.push({
        from: record.supersededBy[index],
        to: record.id,
        file: record.file,
        pointer: `/superseded-by/${index}`,
        field: 'superseded-by',
        declaredBy: record.id,
      })
    }
  }

  declarations.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.from, right.from) ||
    byCodeUnit(left.to, right.to))

  const merged = new Map()
  for (const declaration of declarations) {
    const key = `${declaration.from}${SEP}${declaration.to}`
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, { from: declaration.from, to: declaration.to, declarations: [declaration] })
    } else {
      existing.declarations.push(declaration)
    }
  }

  const edges = [...merged.values()]
  edges.sort((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to))
  return edges
}

/** Canonicalise a cycle so the same loop always serialises identically. */
export function canonicalCycle(path) {
  let smallest = 0
  for (let index = 1; index < path.length; index += 1) {
    if (byCodeUnit(path[index], path[smallest]) < 0) smallest = index
  }
  return [...path.slice(smallest), ...path.slice(0, smallest)]
}

/**
 * Find every distinct cycle reachable through the adjacency map.
 *
 * Depth-first with an explicit stack and an explicit depth bound: recursion
 * depth is a limit like any other here, and exceeding it is reported rather
 * than silently ending the search. Nodes and neighbours are both visited in
 * code-unit order, so the set of reported cycles never depends on insertion
 * order.
 */
export function findCycles(nodeIds, adjacency, maxChainDepth) {
  const sortedNodes = [...nodeIds].sort(byCodeUnit)
  const colour = new Map(sortedNodes.map((id) => [id, 'white']))
  const found = new Map()
  let depthExceeded = false

  for (const start of sortedNodes) {
    if (colour.get(start) !== 'white') continue
    const path = []
    const stack = [{ id: start, neighbours: adjacency.get(start) ?? [], next: 0 }]
    colour.set(start, 'grey')
    path.push(start)

    while (stack.length > 0) {
      if (stack.length > maxChainDepth) {
        depthExceeded = true
        break
      }
      const frame = stack[stack.length - 1]
      if (frame.next >= frame.neighbours.length) {
        colour.set(frame.id, 'black')
        stack.pop()
        path.pop()
        continue
      }
      const neighbour = frame.neighbours[frame.next]
      frame.next += 1
      if (!colour.has(neighbour)) continue
      const state = colour.get(neighbour)
      if (state === 'grey') {
        const at = path.lastIndexOf(neighbour)
        const cycle = canonicalCycle(path.slice(at))
        found.set(cycle.join(SEP), cycle)
        continue
      }
      if (state === 'black') continue
      colour.set(neighbour, 'grey')
      path.push(neighbour)
      stack.push({ id: neighbour, neighbours: adjacency.get(neighbour) ?? [], next: 0 })
    }
    if (depthExceeded) break
  }

  const cycles = [...found.values()]
  cycles.sort((left, right) => byCodeUnit(left.join(SEP), right.join(SEP)))
  return { cycles, depthExceeded }
}

/**
 * Walk forward from a record to the decision that currently stands.
 *
 * Returns `null` when the chain branches, hits a cycle or exceeds the depth
 * bound, because in each of those cases there is no single honest answer and
 * inventing one would misrepresent the history.
 */
export function resolveCurrent(id, successors, maxChainDepth) {
  const seen = new Set([id])
  let node = id
  for (let step = 0; step < maxChainDepth; step += 1) {
    const next = successors.get(node) ?? []
    if (next.length === 0) return node === id ? null : node
    if (next.length > 1) return null
    const candidate = next[0]
    if (seen.has(candidate)) return null
    seen.add(candidate)
    node = candidate
  }
  return null
}

/**
 * Assemble the graph view used by both the report and the index.
 *
 * `records` is an array of `{ id, file, supersedes, supersededBy, status }`,
 * already sorted by id.
 */
export function buildSupersessionGraph(records, maxChainDepth) {
  const known = new Map(records.map((record) => [record.id, record]))
  const edges = buildEdges(records)

  const selfEdges = []
  const missing = []
  const live = []
  for (const edge of edges) {
    if (edge.from === edge.to) {
      selfEdges.push(edge)
      continue
    }
    const absentFrom = !known.has(edge.from)
    const absentTo = !known.has(edge.to)
    if (absentFrom || absentTo) {
      missing.push({ edge, absent: absentFrom ? edge.from : edge.to })
      continue
    }
    live.push(edge)
  }

  const adjacency = new Map(records.map((record) => [record.id, []]))
  const successors = new Map(records.map((record) => [record.id, []]))
  for (const edge of live) {
    adjacency.get(edge.from).push(edge.to)
    successors.get(edge.to).push(edge.from)
  }
  for (const list of adjacency.values()) list.sort(byCodeUnit)
  for (const list of successors.values()) list.sort(byCodeUnit)

  const { cycles, depthExceeded } = findCycles(known.keys(), adjacency, maxChainDepth)
  const inCycle = new Set(cycles.flat())

  const current = new Map()
  for (const record of records) {
    current.set(
      record.id,
      inCycle.has(record.id) || depthExceeded ? null : resolveCurrent(record.id, successors, maxChainDepth),
    )
  }

  /**
   * A declaration is reciprocal when the record on the other end of the edge
   * says the same thing. Missing reciprocity is reported, never repaired: the
   * fix belongs to whoever owns the record, not to an indexer.
   */
  const asymmetric = []
  for (const edge of live) {
    const superseding = known.get(edge.from)
    const superseded = known.get(edge.to)
    const fromDeclares = superseding.supersedes.includes(edge.to)
    const toDeclares = superseded.supersededBy.includes(edge.from)
    if (fromDeclares && toDeclares) continue
    asymmetric.push({
      edge,
      missingSide: fromDeclares ? 'superseded-by' : 'supersedes',
      missingOn: fromDeclares ? superseded : superseding,
    })
  }
  asymmetric.sort((left, right) =>
    byCodeUnit(left.missingOn.file, right.missingOn.file) ||
    byCodeUnit(left.edge.from, right.edge.from) ||
    byCodeUnit(left.edge.to, right.edge.to))

  return {
    edges,
    live,
    selfEdges,
    missing,
    cycles,
    depthExceeded,
    inCycle,
    adjacency,
    successors,
    current,
    asymmetric,
  }
}
