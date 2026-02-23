const { ethers } = require("hardhat");
const { getConditionId, parseTransferBatch } = require("./ctfUtils.js");

/**
 * Splits a condition and returns the resulting position IDs and amounts.
 *
 * @param {Object} params
 * @param {Signer} params.user - The signer executing the split.
 * @param {Contract} params.conditionalFacet - The ConditionalTokensFacet instance.
 * @param {Contract} params.erc20 - The ERC20 collateral token contract.
 * @param {BigNumber} params.amount - Amount of collateral to split.
 * @param {string} params.conditionId - The conditionId to split on.
 * @param {number[]} params.indexSets - The index sets for the outcome tokens.
 * @returns {Promise<[string[], BigNumber[]]>}
 */
async function splitConditionAndGetPositionIds({
  user,
  conditionalFacet,
  erc20,
  amount,
  conditionId,
  indexSets,
}) {
  // Note: splitPosition parameter order is: collateralToken, parentCollectionId, conditionId, partition, amount
  const tx = await conditionalFacet.connect(user).splitPosition(
    erc20.address,
    ethers.constants.HashZero, // Parent collectionId
    conditionId,
    indexSets, // partition (array of outcome indexes)
    amount // amount comes AFTER partition
  );

  const receipt = await tx.wait();

  const { positionIds, amounts } = parseTransferBatch(
    receipt,
    ethers.constants.AddressZero, // from zero address (minting)
    await user.getAddress()
  );

  return [positionIds, amounts];
}

async function createCondition({
  conditionManagerFacet,
  oracle,
  creator,
  questionId,
  outcomeSlotCount,
  metadata = "ipfs://dummy",
  returnTx = false,
}) {
  const conditionId = getConditionId(
    oracle.address,
    questionId,
    outcomeSlotCount
  );

  const tx = await conditionManagerFacet
    .connect(creator)
    .createCondition(
      oracle.address,
      questionId,
      outcomeSlotCount,
      metadata
    );

  const receipt = await tx.wait();

  if (returnTx) {
    return { conditionId, tx, receipt };
  }

  return conditionId;
}

async function createAndSplitCondition({
  conditionManagerFacet,
  conditionalFacet,
  oracle,
  owner,
  erc20,
  questionId,
  outcomeSlotCount = 2,
  splitAmount = ethers.utils.parseEther("2"),
  partition = [1, 2],
  parentCollectionId = ethers.constants.HashZero,
  splitter,
}) {
  const conditionId = getConditionId(
    oracle.address,
    questionId,
    outcomeSlotCount
  );

  await conditionManagerFacet
    .connect(owner)
    .createCondition(
      oracle.address,
      questionId,
      outcomeSlotCount,
      "ipfs://dummy"
    );

  const actor = splitter ?? owner;

  const splitTx = await conditionalFacet
    .connect(actor)
    .splitPosition(
      erc20.address,
      parentCollectionId,
      conditionId,
      partition, // partition comes before amount
      splitAmount
    );

  const receipt = await splitTx.wait();
  const parsed = parseTransferBatch(
    receipt,
    ethers.constants.AddressZero,
    await actor.getAddress()
  );

  return { conditionId, ...parsed };
}

module.exports = {
  splitConditionAndGetPositionIds,
  createCondition,
  createAndSplitCondition,
};
