// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "./LnetAccount.sol";

/**
 * LnetAccountFactory — deterministic factory for LnetAccount proxies.
 *
 * A single LnetAccount implementation is deployed once in the constructor; every user account is a
 * cheap ERC1967 proxy pointing at it, deployed with CREATE2 so its address is known before creation.
 * Bundlers call `createAccount` via the UserOp `initCode` field; `getAddress` is the counterfactual
 * address used off-chain to fund/reference the account before it exists on-chain.
 */
contract LnetAccountFactory {
    LnetAccount public immutable accountImplementation;

    constructor(IEntryPoint _entryPoint) {
        accountImplementation = new LnetAccount(_entryPoint);
    }

    /**
     * Create an account and return its address. Returns the existing account if already deployed
     * (initCode is executed for every UserOp; the account may already exist).
     */
    function createAccount(address owner, uint256 salt) public returns (LnetAccount ret) {
        address addr = getAddress(owner, salt);
        uint256 codeSize = addr.code.length;
        if (codeSize > 0) {
            return LnetAccount(payable(addr));
        }
        ret = LnetAccount(
            payable(new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation), abi.encodeCall(LnetAccount.initialize, (owner))
                ))
        );
    }

    /// @notice Counterfactual address of the account for a given owner + salt.
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(
                    type(ERC1967Proxy).creationCode,
                    abi.encode(address(accountImplementation), abi.encodeCall(LnetAccount.initialize, (owner)))
                )
            )
        );
    }
}
