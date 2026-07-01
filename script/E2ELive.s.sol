// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "@account-abstraction/interfaces/IEntryPoint.sol";
import "@account-abstraction/interfaces/PackedUserOperation.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../src/LnetAccount.sol";
import "../src/LnetAccountFactory.sol";
import "../src/LnetVerifyingPaymaster.sol";

/**
 * Live end-to-end test against the LNET testnet deployment: deploys a fresh Target, then submits a
 * single paymaster-sponsored UserOp that (a) deploys a new LnetAccount via initCode and (b) calls
 * Target.ping() through it. The deployer key acts as the bundler (calls handleOps).
 *
 * Required env:
 *   PRIVATE_KEY           - bundler/deployer (authorized LNET writer)
 *   ENTRYPOINT_ADDRESS, FACTORY_ADDRESS, PAYMASTER_ADDRESS
 *   E2E_OWNER_KEY         - private key that will own the new smart account
 *   PAYMASTER_SIGNER_KEY  - private key matching the paymaster's verifyingSigner
 *   E2E_SALT              - unique salt so the account address is fresh each run
 *
 *   forge script script/E2ELive.s.sol --rpc-url lnet_testnet --broadcast --legacy --with-gas-price 0
 */
contract E2ELive is Script {
    function _packGasLimits(uint256 hi, uint256 lo) internal pure returns (bytes32) {
        return bytes32((hi << 128) | lo);
    }

    IEntryPoint entryPoint;
    LnetAccountFactory factory;
    LnetVerifyingPaymaster paymaster;

    function run() external {
        uint256 bundlerKey = vm.envUint("PRIVATE_KEY");
        entryPoint = IEntryPoint(vm.envAddress("ENTRYPOINT_ADDRESS"));
        factory = LnetAccountFactory(vm.envAddress("FACTORY_ADDRESS"));
        paymaster = LnetVerifyingPaymaster(vm.envAddress("PAYMASTER_ADDRESS"));

        address owner = vm.addr(vm.envUint("E2E_OWNER_KEY"));
        uint256 salt = vm.envUint("E2E_SALT");
        address sender = factory.getAddress(owner, salt);

        console.log("owner:  ", owner);
        console.log("sender: ", sender, "(counterfactual)");

        // 1) Deploy a fresh Target contract the account will call.
        vm.startBroadcast(bundlerKey);
        Target target = new Target();
        vm.stopBroadcast();
        console.log("target: ", address(target));

        // 2+3+4) Build the fully-signed UserOp.
        PackedUserOperation memory op = _buildSignedOp(owner, salt, sender, address(target));

        // 5) Submit via handleOps (bundler = deployer).
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.startBroadcast(bundlerKey);
        entryPoint.handleOps(ops, payable(vm.addr(bundlerKey)));
        vm.stopBroadcast();

        // 6) Verify.
        require(sender.code.length > 0, "account not deployed");
        require(LnetAccount(payable(sender)).owner() == owner, "owner mismatch");
        require(target.pings() == 1, "target not called");
        console.log("OK: account deployed, owner set, Target.ping() executed via sponsored UserOp");
    }

    function _buildSignedOp(address owner, uint256 salt, address sender, address target)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = 0;
        op.initCode =
            abi.encodePacked(address(factory), abi.encodeCall(LnetAccountFactory.createAccount, (owner, salt)));
        op.callData = abi.encodeCall(LnetAccount.execute, (target, 0, abi.encodeCall(Target.ping, ())));
        op.accountGasLimits = _packGasLimits(3_000_000, 1_000_000); // verificationGasLimit, callGasLimit
        op.preVerificationGas = 100_000;
        op.gasFees = _packGasLimits(0, 0); // zero gas on LNET

        op.paymasterAndData = _paymasterAndData(op);
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(vm.envUint("E2E_OWNER_KEY"), MessageHashUtils.toEthSignedMessageHash(userOpHash));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _paymasterAndData(PackedUserOperation memory op) internal view returns (bytes memory) {
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = 0;
        bytes memory pmHeader = abi.encodePacked(
            address(paymaster), uint128(500_000), uint128(100_000), abi.encode(validUntil, validAfter)
        );
        op.paymasterAndData = pmHeader;
        bytes32 pmHash = MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vm.envUint("PAYMASTER_SIGNER_KEY"), pmHash);
        return abi.encodePacked(pmHeader, abi.encodePacked(r, s, v));
    }
}

contract Target {
    uint256 public pings;

    function ping() external {
        pings++;
    }
}
