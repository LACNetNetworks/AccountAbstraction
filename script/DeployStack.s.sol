// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "@account-abstraction/interfaces/IEntryPoint.sol";
import "../src/LnetAccountFactory.sol";
import "../src/LnetVerifyingPaymaster.sol";

/**
 * Deploys the LNET account-abstraction stack (factory + verifying paymaster) against an existing
 * EntryPoint.
 *
 * Required env vars:
 *   PRIVATE_KEY         - deployer key (LNET writer account)
 *   ENTRYPOINT_ADDRESS  - address of the ERC-4337 v0.7 EntryPoint on LNET
 *   PAYMASTER_SIGNER    - address of the off-chain sponsorship signer
 * Optional:
 *   PAYMASTER_DEPOSIT   - wei to deposit into the paymaster's EntryPoint balance (default 0)
 *
 *   forge script script/DeployStack.s.sol --rpc-url lnet_testnet --broadcast --legacy \
 *     --with-gas-price 0
 */
contract DeployStack is Script {
    function run() external returns (LnetAccountFactory factory, LnetVerifyingPaymaster paymaster) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        IEntryPoint entryPoint = IEntryPoint(vm.envAddress("ENTRYPOINT_ADDRESS"));
        address paymasterSigner = vm.envAddress("PAYMASTER_SIGNER");
        uint256 paymasterDeposit = vm.envOr("PAYMASTER_DEPOSIT", uint256(0));

        vm.startBroadcast(pk);

        factory = new LnetAccountFactory(entryPoint);
        paymaster = new LnetVerifyingPaymaster(entryPoint, paymasterSigner);

        if (paymasterDeposit > 0) {
            paymaster.deposit{value: paymasterDeposit}();
        }

        vm.stopBroadcast();

        console.log("EntryPoint:               ", address(entryPoint));
        console.log("LnetAccountFactory:       ", address(factory));
        console.log("  accountImplementation:  ", address(factory.accountImplementation()));
        console.log("LnetVerifyingPaymaster:   ", address(paymaster));
        console.log("  verifyingSigner:        ", paymasterSigner);
    }
}
