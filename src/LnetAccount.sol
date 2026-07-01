// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/* solhint-disable avoid-low-level-calls */
/* solhint-disable no-inline-assembly */

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@account-abstraction/core/BaseAccount.sol";
import "@account-abstraction/core/Helpers.sol";
import "@account-abstraction/samples/callback/TokenCallbackHandler.sol";

/**
 * LnetAccount — a minimal ERC-4337 v0.7 smart account for the LNET (LACChain) network.
 *
 * Single-owner, ECDSA-signature account deployed behind an ERC1967 proxy (see LnetAccountFactory).
 * The implementation is upgradeable via UUPS, gated on the owner. It follows the reference
 * SimpleAccount design so it stays compatible with standard bundlers and the canonical EntryPoint.
 */
contract LnetAccount is BaseAccount, TokenCallbackHandler, UUPSUpgradeable, Initializable {
    /// @notice EOA authorized to control this account.
    address public owner;

    IEntryPoint private immutable _entryPoint;

    event LnetAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner);

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    /// @param anEntryPoint the canonical ERC-4337 v0.7 EntryPoint deployed on LNET.
    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
        _disableInitializers();
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    receive() external payable {}

    function _onlyOwner() internal view {
        // directly through the account itself (which gets redirected through execute()) or the owner EOA.
        require(msg.sender == owner || msg.sender == address(this), "only owner");
    }

    /**
     * Execute a single transaction from this account (called by the EntryPoint during a UserOp,
     * or directly by the owner).
     */
    function execute(address dest, uint256 value, bytes calldata func) external {
        _requireFromEntryPointOrOwner();
        _call(dest, value, func);
    }

    /**
     * Execute a batch of transactions. If `value` is empty, all calls send 0 wei.
     */
    function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func) external {
        _requireFromEntryPointOrOwner();
        require(dest.length == func.length && (value.length == 0 || value.length == func.length), "wrong array lengths");
        if (value.length == 0) {
            for (uint256 i = 0; i < dest.length; i++) {
                _call(dest[i], 0, func[i]);
            }
        } else {
            for (uint256 i = 0; i < dest.length; i++) {
                _call(dest[i], value[i], func[i]);
            }
        }
    }

    /**
     * Initialize the proxy for a given owner. Called once by the factory right after deployment.
     */
    function initialize(address anOwner) public virtual initializer {
        _initialize(anOwner);
    }

    function _initialize(address anOwner) internal virtual {
        owner = anOwner;
        emit LnetAccountInitialized(_entryPoint, owner);
    }

    function _requireFromEntryPointOrOwner() internal view {
        require(msg.sender == address(entryPoint()) || msg.sender == owner, "account: not Owner or EntryPoint");
    }

    /// @inheritdoc BaseAccount
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        virtual
        override
        returns (uint256 validationData)
    {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        if (owner != ECDSA.recover(hash, userOp.signature)) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    // --- EntryPoint deposit helpers ---------------------------------------

    /// @notice Current deposit of this account held by the EntryPoint (used to prefund UserOps).
    function getDeposit() public view returns (uint256) {
        return entryPoint().balanceOf(address(this));
    }

    /// @notice Top up this account's EntryPoint deposit.
    function addDeposit() public payable {
        entryPoint().depositTo{value: msg.value}(address(this));
    }

    /// @notice Withdraw from this account's EntryPoint deposit.
    function withdrawDepositTo(address payable withdrawAddress, uint256 amount) public onlyOwner {
        entryPoint().withdrawTo(withdrawAddress, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        (newImplementation);
        _onlyOwner();
    }
}
