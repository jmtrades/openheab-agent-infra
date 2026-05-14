// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../FeeSplitter.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "no allowance");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FeeSplitterTest is Test {
    FeeSplitter splitter;
    MockUSDC usdc;
    address treasury = address(0xAAAA);
    address alice = address(0xBEEF);
    address bob = address(0xCAFE);

    function setUp() public {
        splitter = new FeeSplitter(treasury, 100);
        usdc = new MockUSDC();
    }

    function test_constructor_sets_values() public {
        assertEq(splitter.treasury(), treasury);
        assertEq(splitter.feeBps(), 100);
        assertEq(splitter.owner(), address(this));
        assertFalse(splitter.paused());
    }

    function test_constructor_rejects_zero_treasury() public {
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(0), 100);
    }

    function test_constructor_rejects_fee_above_max() public {
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.FeeTooHigh.selector, 501, 500));
        new FeeSplitter(treasury, 501);
    }

    function test_transfer_splits_99_1() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(splitter), 1_000_000);
        vm.prank(alice);
        (uint256 net, uint256 fee) = splitter.transfer(address(usdc), bob, 1_000_000);
        assertEq(net, 990_000);
        assertEq(fee, 10_000);
        assertEq(usdc.balanceOf(bob), 990_000);
        assertEq(usdc.balanceOf(treasury), 10_000);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(splitter)), 0);
    }

    function test_transfer_zero_amount_reverts() public {
        vm.prank(alice);
        vm.expectRevert(FeeSplitter.ZeroAmount.selector);
        splitter.transfer(address(usdc), bob, 0);
    }

    function test_transfer_zero_recipient_reverts() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(splitter), 1_000_000);
        vm.prank(alice);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.transfer(address(usdc), address(0), 1_000_000);
    }

    function test_transfer_without_approval_reverts() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        vm.expectRevert();
        splitter.transfer(address(usdc), bob, 1_000_000);
    }

    function test_paused_blocks_transfers() public {
        splitter.setPaused(true);
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(splitter), 1_000_000);
        vm.prank(alice);
        vm.expectRevert(FeeSplitter.Paused.selector);
        splitter.transfer(address(usdc), bob, 1_000_000);
    }

    function test_set_fee_caps_at_max() public {
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.FeeTooHigh.selector, 501, 500));
        splitter.setFee(501);
    }

    function test_set_treasury() public {
        address newTreasury = address(0xCAFEBABE);
        splitter.setTreasury(newTreasury);
        assertEq(splitter.treasury(), newTreasury);
    }

    function test_only_owner_can_set_treasury() public {
        vm.prank(alice);
        vm.expectRevert(FeeSplitter.NotOwner.selector);
        splitter.setTreasury(alice);
    }

    function test_transfer_ownership() public {
        splitter.transferOwnership(alice);
        assertEq(splitter.owner(), alice);
    }

    function test_transfer_emits_event() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(splitter), 1_000_000);
        vm.expectEmit(true, true, true, true);
        emit FeeSplitter.TransferRouted(address(usdc), alice, bob, 1_000_000, 990_000, 10_000);
        vm.prank(alice);
        splitter.transfer(address(usdc), bob, 1_000_000);
    }

    function test_sweep_recovers_funds() public {
        usdc.mint(address(splitter), 500_000);
        splitter.sweep(address(usdc), treasury);
        assertEq(usdc.balanceOf(treasury), 500_000);
        assertEq(usdc.balanceOf(address(splitter)), 0);
    }

    function test_zero_fee_works() public {
        FeeSplitter zeroFee = new FeeSplitter(treasury, 0);
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(zeroFee), 1_000_000);
        vm.prank(alice);
        (uint256 net, uint256 fee) = zeroFee.transfer(address(usdc), bob, 1_000_000);
        assertEq(net, 1_000_000);
        assertEq(fee, 0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function testFuzz_split_invariant(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(splitter), amount);
        vm.prank(alice);
        (uint256 net, uint256 fee) = splitter.transfer(address(usdc), bob, amount);
        assertEq(net + fee, amount, "net + fee must equal gross");
        assertEq(fee, (amount * 100) / 10000, "fee must be 1% of gross");
    }
}
