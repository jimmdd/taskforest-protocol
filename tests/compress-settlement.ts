import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Taskforest } from "../target/types/taskforest";
import { TaskforestPayments } from "../target/types/taskforest_payments";
import { expect } from "chai";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import {
  accountCompressionProgram,
  bn,
  confirmTx,
  createRpc,
  defaultTestStateTreeAccounts,
  deriveAddress,
  deriveAddressSeed,
  getAccountCompressionAuthority,
  getRegisteredProgramPda,
  lightSystemProgram,
  sleep,
} from "@lightprotocol/stateless.js";

describe("taskforest-payments compression", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const coreProgram = anchor.workspace.Taskforest as Program<Taskforest>;
  const paymentsProgram = anchor.workspace.TaskforestPayments as Program<TaskforestPayments>;
  const poster = provider.wallet;
  let idCounter = Date.now();

  function nextId(): BN {
    idCounter += 1;
    return new BN(idCounter);
  }

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  function hash32(fill: number): number[] {
    return Array.from({ length: 32 }, () => fill);
  }

  function pdaJob(posterKey: PublicKey, jobId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("job"), posterKey.toBuffer(), jobId.toArrayLike(Buffer, "le", 8)],
      coreProgram.programId
    )[0];
  }

  function pdaEscrow(escrowId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowId.toArrayLike(Buffer, "le", 8)],
      paymentsProgram.programId
    )[0];
  }

  async function initializeAssignedJob(jobId: BN, agent: PublicKey): Promise<PublicKey> {
    const job = pdaJob(poster.publicKey, jobId);
    await coreProgram.methods
      .initializeJob(
        jobId,
        new BN(2_000_000),
        new BN(nowSec() + 1200),
        hash32(1),
        hash32(2),
        0,
        hash32(0),
        1,
        0,
        0
      )
      .accountsPartial({
        job,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await coreProgram.methods
      .autoAssignJob(agent)
      .accountsPartial({ job, poster: poster.publicKey })
      .rpc();

    return job;
  }

  function sessionIdBytes(label: string): number[] {
    return Array.from(Buffer.from(label.padEnd(32, "\0").slice(0, 32)));
  }

  it("compress_settlement writes a compressed settlement leaf", async function () {
    this.timeout(120000);

    const rpc = createRpc("http://127.0.0.1:8899", "http://127.0.0.1:8784", "http://127.0.0.1:3001", {
      commitment: "confirmed",
    });
    const agent = poster.publicKey;
    const escrowId = nextId();
    const job = await initializeAssignedJob(nextId(), agent);
    const escrow = pdaEscrow(escrowId);
    const deposit = 1_000_000;
    const totalPaid = 600_000;

    await paymentsProgram.methods
      .createEscrowWrapper(escrowId, new BN(deposit), sessionIdBytes("mpp-compress"))
      .accountsPartial({
        job,
        escrow,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const escrowInfo = await provider.connection.getAccountInfo(escrow);
    expect(escrowInfo).to.not.eq(null);
    expect(escrowInfo!.owner.toBase58()).to.eq(paymentsProgram.programId.toBase58());

    const outputStateTree = defaultTestStateTreeAccounts().merkleTree;
    const addressTree = defaultTestStateTreeAccounts().addressTree;
    const addressQueue = defaultTestStateTreeAccounts().addressQueue;

    const seed = deriveAddressSeed(
      [Buffer.from("compressed_settlement"), escrow.toBytes()],
      paymentsProgram.programId
    );
    const compressedAddress = deriveAddress(seed, addressTree);
    const proofRpcResult = await rpc.getValidityProofV0([], [
      {
        tree: addressTree,
        queue: addressQueue,
        address: bn(compressedAddress.toBytes()),
      },
    ]);

    const cpiAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("cpi_authority")],
      paymentsProgram.programId
    )[0];
    const outputStateTreeIndex = 0;
    const addressMerkleTreePubkeyIndex = 1;
    const addressQueuePubkeyIndex = 2;
    const remainingAccountMetas = [
      { pubkey: new PublicKey(lightSystemProgram), isSigner: false, isWritable: false },
      { pubkey: cpiAuthority, isSigner: false, isWritable: false },
      { pubkey: getRegisteredProgramPda(), isSigner: false, isWritable: false },
      { pubkey: getAccountCompressionAuthority(), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(accountCompressionProgram), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: outputStateTree, isSigner: false, isWritable: true },
      { pubkey: addressTree, isSigner: false, isWritable: true },
      { pubkey: addressQueue, isSigner: false, isWritable: true },
    ];
    const packedAddressTreeInfo = {
      rootIndex: proofRpcResult.rootIndices[0],
      addressMerkleTreePubkeyIndex,
      addressQueuePubkeyIndex,
    };

    const tx = await paymentsProgram.methods
      .compressSettlement({ 0: proofRpcResult.compressedProof }, packedAddressTreeInfo, outputStateTreeIndex, new BN(totalPaid))
      .accountsPartial({
        escrow,
        signer: poster.publicKey,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_000_000,
        }),
      ])
      .remainingAccounts(remainingAccountMetas)
      .transaction();
    const ix = tx.instructions[tx.instructions.length - 1];
    const signature = await provider.sendAndConfirm(tx, []);
    await confirmTx(rpc, signature);
    await sleep(1500);

    const compressedAccount = await rpc.getCompressedAccount(bn(compressedAddress.toBytes()));
    expect(compressedAccount).to.not.eq(null);
    expect(compressedAccount.data.data.length).to.be.greaterThan(0);
  });
});
