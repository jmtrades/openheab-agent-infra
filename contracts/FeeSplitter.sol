// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title OpenHeab FeeSplitter
 * @notice ERC-20 transfer router that takes a per-tx fee.
 *         Sender approves this contract; calls transfer(asset, recipient, amount);
 *         contract pulls amount via transferFrom, sends fee% to treasury, rest to recipient.
 *
 * - feeBps capped at 500 (5%)
 * - No funds ever held — every transfer settles atomically
 * - Reentrancy guard on the one mutating external function
 * - Owner can pause in emergency
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FeeSplitter {
    address public owner;
    address public treasury;
    uint16  public feeBps;
    uint16  public constant MAX_FEE_BPS = 500;
    bool    public paused;

    uint256 private _entered;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    event TransferRouted(
        address indexed asset,
        address indexed from,
        address indexed to,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount
    );
    event TreasuryChanged(address indexed previous, address indexed next);
    event FeeChanged(uint16 previousBps, uint16 nextBps);
    event PauseChanged(bool paused);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error Paused();
    error FeeTooHigh(uint16 attempted, uint16 max);
    error ZeroAddress();
    error ZeroAmount();
    error TransferFromFailed();
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == _ENTERED) revert Reentrancy();
        _entered = _ENTERED;
        _;
        _entered = _NOT_ENTERED;
    }

    constructor(address _treasury, uint16 _feeBps) {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps, MAX_FEE_BPS);
        owner = msg.sender;
        treasury = _treasury;
        feeBps = _feeBps;
        _entered = _NOT_ENTERED;
        emit TreasuryChanged(address(0), _treasury);
        emit FeeChanged(0, _feeBps);
        emit OwnerChanged(address(0), msg.sender);
    }

    function transfer(address asset, address to, uint256 amount)
        external
        nonReentrant
        returns (uint256 netAmount, uint256 feeAmount)
    {
        if (paused) revert Paused();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        feeAmount = (amount * uint256(feeBps)) / 10000;
        netAmount = amount - feeAmount;

        if (!IERC20(asset).transferFrom(msg.sender, address(this), amount)) {
            revert TransferFromFailed();
        }
        if (!IERC20(asset).transfer(to, netAmount)) {
            revert TransferFailed();
        }
        if (feeAmount > 0) {
            if (!IERC20(asset).transfer(treasury, feeAmount)) {
                revert TransferFailed();
            }
        }

        emit TransferRouted(asset, msg.sender, to, amount, netAmount, feeAmount);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, next);
        treasury = next;
    }

    function setFee(uint16 nextBps) external onlyOwner {
        if (nextBps > MAX_FEE_BPS) revert FeeTooHigh(nextBps, MAX_FEE_BPS);
        emit FeeChanged(feeBps, nextBps);
        feeBps = nextBps;
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PauseChanged(p);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function sweep(address asset, address to) external onlyOwner {
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) return;
        if (!IERC20(asset).transfer(to, bal)) revert TransferFailed();
    }
}
