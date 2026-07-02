// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/* solhint-disable reason-string */

import "@account-abstraction/core/BasePaymaster.sol";
import "@account-abstraction/core/UserOperationLib.sol";
import "@account-abstraction/core/Helpers.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * LnetVerifyingPaymaster — sponsors gas for UserOperations on LNET.
 *
 * An off-chain service (the "verifying signer") decides which UserOps to sponsor and signs a hash
 * over their fields plus a [validAfter, validUntil] validity window. This contract only verifies
 * that signature on-chain, so all sponsorship policy lives off-chain.
 *
 * NOTE on LNET: because the network runs with gasPrice = 0, gas cost is effectively zero and this
 * paymaster mainly serves as an allow-list / policy gate for who may transact through the EntryPoint,
 * rather than for economic gas subsidy. The EntryPoint still requires the paymaster to hold a deposit;
 * with gasPrice = 0 the required prefund is 0, but a deposit + stake is still recommended for
 * bundler reputation rules.
 */
contract LnetVerifyingPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    /// @notice Off-chain signer that authorizes sponsorship.
    address public verifyingSigner;

    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;

    event VerifyingSignerChanged(address indexed previousSigner, address indexed newSigner);

    constructor(IEntryPoint _entryPoint, address _verifyingSigner) BasePaymaster(_entryPoint) {
        require(_verifyingSigner != address(0), "invalid signer");
        verifyingSigner = _verifyingSigner;
    }

    /// @notice Rotate the off-chain sponsorship signer.
    function setVerifyingSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "invalid signer");
        emit VerifyingSignerChanged(verifyingSigner, newSigner);
        verifyingSigner = newSigner;
    }

    /**
     * Hash the off-chain service signs (and this contract validates on-chain). Covers every UserOp
     * field except `paymasterAndData` (which carries the signature itself), pinned to this chain and
     * this paymaster.
     */
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        address sender = userOp.getSender();
        return keccak256(
            abi.encode(
                sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    /**
     * paymasterAndData layout:
     *   [0:20]   paymaster address
     *   [20:36]  paymaster verification gas limit
     *   [36:52]  paymaster postOp gas limit
     *   [52:116] abi.encode(validUntil, validAfter)
     *   [116:]   signature
     */
    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 requiredPreFund)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        (requiredPreFund);
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);
        require(
            signature.length == 64 || signature.length == 65,
            "LnetVerifyingPaymaster: invalid signature length in paymasterAndData"
        );
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));

        if (verifyingSigner != ECDSA.recover(hash, signature)) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }
        return ("", _packValidationData(false, validUntil, validAfter));
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        (validUntil, validAfter) = abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }
}
