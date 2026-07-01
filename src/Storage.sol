// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// Minimal storage contract — used to probe plain (non-AA) contract deployment / calls on LNET.
contract Storage {
    uint256 public value;

    event ValueSet(uint256 value);

    function set(uint256 newValue) external {
        value = newValue;
        emit ValueSet(newValue);
    }
}
