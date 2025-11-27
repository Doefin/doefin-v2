async function sendAndApproveERC1155({
  token,
  sender,
  to,
  tokenId,
  spender,
  amount,
}) {
  await token
    .connect(sender)
    .safeTransferFrom(sender.address, to.address, tokenId, amount, "0x");
  await token.connect(to).setApprovalForAll(spender, true);
}

module.exports = {
  sendAndApproveERC1155,
};
