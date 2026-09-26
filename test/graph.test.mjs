import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEdges,
  buildSupersessionGraph,
  canonicalCycle,
  findCycles,
  resolveCurrent,
} from '../src/graph.mjs'

function makeRecord(id, overrides = {}) {
  return {
    id,
    file: `${id.toLowerCase()}.md`,
    status: 'accepted',
    supersedes: [],
    supersededBy: [],
    ...overrides,
  }
}

function adjacencyFrom(pairs) {
  const map = new Map()
  for (const [from, to] of pairs) {
    if (!map.has(from)) map.set(from, [])
    if (!map.has(to)) map.set(to, [])
    map.get(from).push(to)
  }
  for (const list of map.values()) list.sort()
  return map
}

test('both declaration directions collapse into one edge that remembers each source', () => {
  const edges = buildEdges([
    makeRecord('ADR-0001', { supersededBy: ['ADR-0004'] }),
    makeRecord('ADR-0004', { supersedes: ['ADR-0001'] }),
  ])

  assert.deepEqual(
    edges.map((edge) => [edge.from, edge.to, edge.declarations.map((item) => `${item.file}${item.pointer}`)]),
    [['ADR-0004', 'ADR-0001', ['adr-0001.md/superseded-by/0', 'adr-0004.md/supersedes/0']]],
  )
})

test('edges are ordered by endpoint, not by the order records declared them', () => {
  const edges = buildEdges([
    makeRecord('ADR-0009', { supersedes: ['ADR-0007', 'ADR-0002'] }),
    makeRecord('ADR-0003', { supersedes: ['ADR-0001'] }),
  ])
  assert.deepEqual(
    edges.map((edge) => `${edge.from}->${edge.to}`),
    ['ADR-0003->ADR-0001', 'ADR-0009->ADR-0002', 'ADR-0009->ADR-0007'],
  )
})

test('a cycle is reported once, rotated to start at its smallest member', () => {
  assert.deepEqual(canonicalCycle(['C', 'A', 'B']), ['A', 'B', 'C'])
  assert.deepEqual(canonicalCycle(['B', 'C', 'A']), ['A', 'B', 'C'])
})

test('findCycles returns the exact cycle A supersedes B supersedes A', () => {
  const adjacency = adjacencyFrom([['ADR-0010', 'ADR-0011'], ['ADR-0011', 'ADR-0010']])
  const { cycles, depthExceeded } = findCycles(adjacency.keys(), adjacency, 64)
  assert.deepEqual(cycles, [['ADR-0010', 'ADR-0011']])
  assert.equal(depthExceeded, false)
})

test('two disjoint cycles are both reported, in code-unit order', () => {
  const adjacency = adjacencyFrom([
    ['B1', 'B2'],
    ['B2', 'B1'],
    ['A1', 'A2'],
    ['A2', 'A3'],
    ['A3', 'A1'],
  ])
  const { cycles } = findCycles(adjacency.keys(), adjacency, 64)
  assert.deepEqual(cycles, [['A1', 'A2', 'A3'], ['B1', 'B2']])
})

test('the reported cycles do not depend on the order nodes were inserted', () => {
  const forward = adjacencyFrom([['A1', 'A2'], ['A2', 'A3'], ['A3', 'A1'], ['B1', 'B2'], ['B2', 'B1']])
  const reversed = adjacencyFrom([['B2', 'B1'], ['B1', 'B2'], ['A3', 'A1'], ['A2', 'A3'], ['A1', 'A2']])
  assert.notDeepEqual([...forward.keys()], [...reversed.keys()])
  assert.deepEqual(findCycles(reversed.keys(), reversed, 64).cycles, [['A1', 'A2', 'A3'], ['B1', 'B2']])
  assert.deepEqual(findCycles(forward.keys(), forward, 64).cycles, findCycles(reversed.keys(), reversed, 64).cycles)
})

test('an acyclic graph yields no cycles', () => {
  const adjacency = adjacencyFrom([['ADR-0004', 'ADR-0001'], ['ADR-0005', 'ADR-0004']])
  assert.deepEqual(findCycles(adjacency.keys(), adjacency, 64).cycles, [])
})

test('traversal past maxChainDepth is reported instead of silently stopping', () => {
  const pairs = []
  for (let index = 0; index < 12; index += 1) {
    pairs.push([`N${String(index).padStart(2, '0')}`, `N${String(index + 1).padStart(2, '0')}`])
  }
  const adjacency = adjacencyFrom(pairs)
  assert.deepEqual(findCycles(adjacency.keys(), adjacency, 4), { cycles: [], depthExceeded: true })
  assert.deepEqual(findCycles(adjacency.keys(), adjacency, 64), { cycles: [], depthExceeded: false })
})

test('resolveCurrent walks a chain forward to the decision that stands', () => {
  const successors = new Map([
    ['ADR-0001', ['ADR-0002']],
    ['ADR-0002', ['ADR-0005']],
    ['ADR-0005', []],
  ])
  assert.equal(resolveCurrent('ADR-0001', successors, 64), 'ADR-0005')
  assert.equal(resolveCurrent('ADR-0002', successors, 64), 'ADR-0005')
  assert.equal(resolveCurrent('ADR-0005', successors, 64), null)
})

test('resolveCurrent refuses to guess when a chain branches or loops', () => {
  const branching = new Map([['A', ['B', 'C']], ['B', []], ['C', []]])
  assert.equal(resolveCurrent('A', branching, 64), null)

  const looping = new Map([['A', ['B']], ['B', ['A']]])
  assert.equal(resolveCurrent('A', looping, 64), null)

  const long = new Map([['A', ['B']], ['B', ['C']], ['C', []]])
  assert.equal(resolveCurrent('A', long, 1), null)
})

test('the assembled graph separates self edges, missing targets and live edges', () => {
  const graph = buildSupersessionGraph(
    [
      makeRecord('ADR-0001', { status: 'superseded', supersededBy: ['ADR-0004'] }),
      makeRecord('ADR-0002', { supersedes: ['ADR-0002'] }),
      makeRecord('ADR-0003', { supersedes: ['ADR-9999'] }),
      makeRecord('ADR-0004', { supersedes: ['ADR-0001'] }),
    ],
    64,
  )

  assert.deepEqual(graph.live.map((edge) => `${edge.from}->${edge.to}`), ['ADR-0004->ADR-0001'])
  assert.deepEqual(graph.selfEdges.map((edge) => edge.from), ['ADR-0002'])
  assert.deepEqual(graph.missing.map((item) => [item.edge.from, item.edge.to, item.absent]), [
    ['ADR-0003', 'ADR-9999', 'ADR-9999'],
  ])
  assert.deepEqual(graph.cycles, [])
  assert.deepEqual(graph.asymmetric, [])
  assert.equal(graph.current.get('ADR-0001'), 'ADR-0004')
  assert.equal(graph.current.get('ADR-0004'), null)
})

test('a one-sided supersession declaration is reported against the record that is silent', () => {
  const graph = buildSupersessionGraph(
    [makeRecord('ADR-0001'), makeRecord('ADR-0004', { supersedes: ['ADR-0001'] })],
    64,
  )
  assert.deepEqual(
    graph.asymmetric.map((item) => [item.edge.from, item.edge.to, item.missingSide, item.missingOn.id]),
    [['ADR-0004', 'ADR-0001', 'superseded-by', 'ADR-0001']],
  )
})

test('records inside a cycle get no current decision', () => {
  const graph = buildSupersessionGraph(
    [
      makeRecord('ADR-0010', { supersedes: ['ADR-0011'] }),
      makeRecord('ADR-0011', { supersedes: ['ADR-0010'] }),
    ],
    64,
  )
  assert.deepEqual(graph.cycles, [['ADR-0010', 'ADR-0011']])
  assert.equal(graph.current.get('ADR-0010'), null)
  assert.equal(graph.current.get('ADR-0011'), null)
})
