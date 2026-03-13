import { createHash } from 'crypto'
import type { ExecutionReceipt, ToolCallReceipt, ReceiptDAG } from './types'

function sha256(data: Uint8Array | string): number[] {
  const input = typeof data === 'string' ? data : Buffer.from(data)
  return Array.from(createHash('sha256').update(input).digest())
}

function hashReceipt(receipt: ExecutionReceipt): number[] {
  const payload = JSON.stringify({
    threadId: receipt.threadId,
    parentThreadId: receipt.parentThreadId,
    agentId: receipt.agentId,
    input_hash: receipt.input_hash,
    output_hash: receipt.output_hash,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    toolCalls: receipt.toolCalls,
  })
  return sha256(payload)
}

function combineHashes(left: number[], right: number[]): number[] {
  const combined = new Uint8Array(64)
  combined.set(new Uint8Array(left), 0)
  combined.set(new Uint8Array(right), 32)
  return sha256(combined)
}

function computeMerkleRoot(dag: ReceiptDAG): number[] {
  const selfHash = hashReceipt(dag.root)

  if (dag.children.length === 0) {
    return selfHash
  }

  const childRoots = dag.children.map(computeMerkleRoot)

  let currentHash = selfHash
  for (const childRoot of childRoots) {
    currentHash = combineHashes(currentHash, childRoot)
  }

  return currentHash
}

export function createReceipt(
  threadId: number,
  agentId: string,
  inputData: unknown,
  outputData: unknown,
  toolCalls: ToolCallReceipt[],
  parentThreadId?: number,
): ExecutionReceipt {
  return {
    threadId,
    parentThreadId: parentThreadId ?? null,
    agentId,
    input_hash: sha256(JSON.stringify(inputData)),
    output_hash: sha256(JSON.stringify(outputData)),
    startedAt: 0,
    completedAt: 0,
    toolCalls,
  }
}

export function createToolCallReceipt(
  tool: string,
  input: unknown,
  output: unknown,
  durationMs: number,
): ToolCallReceipt {
  return {
    tool,
    input_hash: sha256(JSON.stringify(input)),
    output_hash: sha256(JSON.stringify(output)),
    duration_ms: durationMs,
  }
}

export function buildDAG(
  root: ExecutionReceipt,
  children: ReceiptDAG[] = [],
): ReceiptDAG {
  const merkleRoot = computeMerkleRoot({ root, children, merkleRoot: [] })
  return { root, children, merkleRoot }
}

export function getMerkleRoot(dag: ReceiptDAG): number[] {
  return computeMerkleRoot(dag)
}

export function serializeDAG(dag: ReceiptDAG): string {
  return JSON.stringify(dag)
}

export function deserializeDAG(json: string): ReceiptDAG {
  const parsed = JSON.parse(json) as ReceiptDAG
  parsed.merkleRoot = computeMerkleRoot(parsed)
  return parsed
}

export function getReceiptUriHash(uri: string): number[] {
  return sha256(uri)
}
