// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "@account-abstraction/core/EntryPoint.sol";

/**
 * Deploys the canonical ERC-4337 v0.7 EntryPoint on LNET testnet.
 *
 * Only needed if LNET does not already have a canonical EntryPoint. On public EVM networks the
 * canonical address is 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (deployed via a deterministic
 * factory). On a permissioned network you typically deploy your own instance and reference it via
 * the ENTRYPOINT_ADDRESS env var in the other scripts.
 *
 *   forge script script/DeployEntryPoint.s.sol --rpc-url lnet_testnet --broadcast --legacy \
 *     --with-gas-price 0
 */
contract DeployEntryPoint is Script {
    function run() external returns (EntryPoint entryPoint) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        entryPoint = new EntryPoint();
        vm.stopBroadcast();
        console.log("EntryPoint deployed at:", address(entryPoint));
    }
}
