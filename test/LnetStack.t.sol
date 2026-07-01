// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "@account-abstraction/core/EntryPoint.sol";
import "@account-abstraction/interfaces/PackedUserOperation.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import "../src/LnetAccount.sol";
import "../src/LnetAccountFactory.sol";
import "../src/LnetVerifyingPaymaster.sol";

/**
 * End-to-end tests for the LNET AA stack, mirroring how a bundler drives the EntryPoint.
 *
 * All UserOps run with gasPrice = 0 (maxFeePerGas = maxPriorityFeePerGas = 0), matching LNET's
 * zero-gas EVM: no prefund is required from the account or paymaster, so the tests exercise the
 * validation/execution flow rather than gas economics.
 */
contract LnetStackTest is Test {
    EntryPoint entryPoint;
    LnetAccountFactory factory;
    LnetVerifyingPaymaster paymaster;

    // Test EOA that owns the smart account.
    uint256 ownerKey = 0xA11CE;
    address owner;

    // Off-chain paymaster sponsorship signer.
    uint256 signerKey = 0xBEEF;
    address paymasterSigner;

    address beneficiary = address(0xB0B);

    function setUp() public {
        owner = vm.addr(ownerKey);
        paymasterSigner = vm.addr(signerKey);

        entryPoint = new EntryPoint();
        factory = new LnetAccountFactory(IEntryPoint(address(entryPoint)));
        paymaster = new LnetVerifyingPaymaster(IEntryPoint(address(entryPoint)), paymasterSigner);
    }

    function _packGasLimits(uint256 hi, uint256 lo) internal pure returns (bytes32) {
        return bytes32((hi << 128) | lo);
    }

    function _baseUserOp(address sender, bytes memory initCode, bytes memory callData)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = 0;
        op.initCode = initCode;
        op.callData = callData;
        op.accountGasLimits = _packGasLimits(2_000_000, 2_000_000); // verificationGasLimit, callGasLimit
        op.preVerificationGas = 100_000;
        op.gasFees = _packGasLimits(0, 0); // maxPriorityFeePerGas, maxFeePerGas — zero gas on LNET
        op.paymasterAndData = "";
        op.signature = "";
    }

    function _sign(PackedUserOperation memory op) internal view returns (bytes memory) {
        bytes32 hash = entryPoint.getUserOpHash(op);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(hash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_getAddress_matchesDeployedAccount() public {
        uint256 salt = 1;
        address predicted = factory.getAddress(owner, salt);
        LnetAccount account = factory.createAccount(owner, salt);
        assertEq(address(account), predicted, "counterfactual address mismatch");
        assertEq(account.owner(), owner, "owner not initialized");
    }

    function test_createAccount_isIdempotent() public {
        uint256 salt = 2;
        LnetAccount a = factory.createAccount(owner, salt);
        LnetAccount b = factory.createAccount(owner, salt);
        assertEq(address(a), address(b), "factory should return existing account");
    }

    function test_handleOps_deploysAndExecutes() public {
        uint256 salt = 3;
        address sender = factory.getAddress(owner, salt);

        bytes memory initCode =
            abi.encodePacked(address(factory), abi.encodeCall(LnetAccountFactory.createAccount, (owner, salt)));

        // Have the account call a target that records the call.
        address target = address(new Target());
        bytes memory callData = abi.encodeCall(LnetAccount.execute, (target, 0, abi.encodeCall(Target.ping, ())));

        PackedUserOperation memory op = _baseUserOp(sender, initCode, callData);
        op.signature = _sign(op);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        entryPoint.handleOps(ops, payable(beneficiary));

        assertEq(Target(target).pings(), 1, "target not called via account");
        assertGt(sender.code.length, 0, "account not deployed");
        assertEq(LnetAccount(payable(sender)).owner(), owner, "owner mismatch after deploy");
    }

    function test_paymaster_sponsorsUserOp() public {
        uint256 salt = 4;
        address sender = factory.getAddress(owner, salt);
        factory.createAccount(owner, salt); // deploy up front for a clean paymaster-only path

        address target = address(new Target());
        bytes memory callData = abi.encodeCall(LnetAccount.execute, (target, 0, abi.encodeCall(Target.ping, ())));

        PackedUserOperation memory op = _baseUserOp(sender, "", callData);

        // Build paymasterAndData: [paymaster(20)][verifGas(16)][postOpGas(16)][validUntil,validAfter(64)][sig]
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;
        bytes memory pmHeader = abi.encodePacked(
            address(paymaster),
            uint128(500_000), // paymaster verification gas
            uint128(100_000), // paymaster postOp gas
            abi.encode(validUntil, validAfter)
        );
        // Sign the paymaster hash over the op that already carries the header (empty sig tail).
        op.paymasterAndData = pmHeader;
        bytes32 pmHash = MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, pmHash);
        op.paymasterAndData = abi.encodePacked(pmHeader, abi.encodePacked(r, s, v));

        op.signature = _sign(op);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        entryPoint.handleOps(ops, payable(beneficiary));
        assertEq(Target(target).pings(), 1, "sponsored op did not execute");
    }
}

/// Minimal call target used to observe account execution.
contract Target {
    uint256 public pings;

    function ping() external {
        pings++;
    }
}
