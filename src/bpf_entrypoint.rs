use crate::instruction::TaskForestInstruction;
use pinocchio::error::ProgramError;
use pinocchio::{entrypoint, AccountView, Address, ProgramResult};

solana_address::declare_id!("11111111111111111111111111111111");

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Address,
    _accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    TaskForestInstruction::unpack(instruction_data)
        .map(|_| ())
        .map_err(|_| ProgramError::InvalidInstructionData)
}
