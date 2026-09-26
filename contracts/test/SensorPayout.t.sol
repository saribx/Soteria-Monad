// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { SensorPayout, SensorPayoutFactory } from "../src/SensorPayout.sol";

contract SensorPayoutTest is Test {
    SensorPayoutFactory f;
    address oracle = address(this);
    address payable carrier = payable(address(0xCA));
    address payable customer = payable(address(0xC1));

    // demo scale: 1 MON = EUR 100,000
    uint256 constant FROZEN_RATE = 0.0002 ether; // EUR 20/s
    uint256 constant FROZEN_CAP = 0.06 ether; // EUR 6,000
    uint256 constant PHARMA_RATE = 0.004 ether; // EUR 400/s
    uint256 constant PHARMA_CAP = 0.12 ether; // EUR 12,000

    function setUp() public {
        vm.warp(1_790_000_000);
        f = new SensorPayoutFactory();
        vm.deal(address(this), 100 ether);
    }

    function _templates() internal pure returns (SensorPayoutFactory.Template[] memory ts) {
        ts = new SensorPayoutFactory.Template[](3);
        ts[0] = SensorPayoutFactory.Template("s1/W02/temp", 1, -150, 10, FROZEN_RATE, FROZEN_CAP);
        ts[1] = SensorPayoutFactory.Template("s3/W02/temp", 1, 80, 10, PHARMA_RATE, PHARMA_CAP);
        ts[2] = SensorPayoutFactory.Template("s3/W05/pressure", 2, 38, 0, 0.09 ether, 0.09 ether);
    }

    function _make() internal returns (address[] memory) {
        f.createMany{ value: FROZEN_CAP + PHARMA_CAP + 0.09 ether }(
            _templates(), 1, SensorPayoutFactory.Parties(oracle, carrier, customer)
        );
        return f.all();
    }

    function test_copiesHoldTheirBond() public {
        address[] memory m = _make();
        assertEq(m.length, 3);
        assertEq(m[0].balance, FROZEN_CAP);
        assertEq(m[1].balance, PHARMA_CAP);
        assertEq(SensorPayout(payable(m[0])).cap(), FROZEN_CAP);
    }

    function test_wrongValue_reverts() public {
        vm.expectRevert("value must equal the sum of the caps");
        f.createMany{ value: 1 ether }(_templates(), 1, SensorPayoutFactory.Parties(oracle, carrier, customer));
    }

    function test_graceThenPerSecond() public {
        SensorPayout s = SensorPayout(payable(_make()[0]));
        s.report(-142); // excursion starts at t0
        assertEq(customer.balance, 0);
        vm.warp(block.timestamp + 8);
        s.report(-140); // still inside grace
        assertEq(customer.balance, 0);
        vm.warp(block.timestamp + 5); // t0 + 13 → 3 s past grace
        s.report(-138);
        assertEq(customer.balance, 3 * FROZEN_RATE);
        vm.warp(block.timestamp + 4); // t0 + 17 → 4 more seconds
        s.report(-135);
        assertEq(customer.balance, 7 * FROZEN_RATE);
        assertEq(s.paid(), 7 * FROZEN_RATE);
    }

    function test_recoveryStopsPayments() public {
        SensorPayout s = SensorPayout(payable(_make()[0]));
        s.report(-142);
        vm.warp(block.timestamp + 12);
        s.report(-200); // back inside: settles 2 s, ends the excursion
        assertEq(customer.balance, 2 * FROZEN_RATE);
        assertEq(s.breachStart(), 0);
        vm.warp(block.timestamp + 30);
        s.report(-199);
        assertEq(customer.balance, 2 * FROZEN_RATE);
    }

    function test_capLimitsPayout() public {
        SensorPayout s = SensorPayout(payable(_make()[1]));
        s.report(95);
        vm.warp(block.timestamp + 10 + 1000); // far past the cap
        s.report(96);
        assertEq(customer.balance, PHARMA_CAP);
        assertEq(address(s).balance, 0);
        vm.warp(block.timestamp + 10);
        s.report(97); // nothing left, no revert
        assertEq(customer.balance, PHARMA_CAP);
    }

    function test_noGrace_lumpSumAfterOneSecond() public {
        SensorPayout s = SensorPayout(payable(_make()[2]));
        s.report(31);
        assertEq(customer.balance, 0); // same second: nothing owed yet
        vm.warp(block.timestamp + 1);
        s.report(30);
        assertEq(customer.balance, 0.09 ether);
    }

    function test_deliverRefundsRest() public {
        SensorPayout s = SensorPayout(payable(_make()[0]));
        s.report(-142);
        vm.warp(block.timestamp + 15);
        s.deliver(); // settles 5 s, then refunds the rest
        assertEq(customer.balance, 5 * FROZEN_RATE);
        assertEq(carrier.balance, FROZEN_CAP - 5 * FROZEN_RATE);
        assertEq(address(s).balance, 0);
        vm.expectRevert(SensorPayout.NotActive.selector);
        s.report(-150);
    }

    function test_onlyOracle() public {
        SensorPayout s = SensorPayout(payable(_make()[0]));
        vm.prank(address(0xBAD));
        vm.expectRevert(SensorPayout.NotOracle.selector);
        s.report(0);
    }

    function test_noReinit() public {
        SensorPayout s = SensorPayout(payable(_make()[0]));
        vm.expectRevert(SensorPayout.AlreadyInitialized.selector);
        s.init{ value: 1 }("x", 1, 0, 0, 0, address(0xBAD), payable(address(0xBAD)), payable(address(0xBAD)));
    }

    function test_dueView() public {
        SensorPayout s = SensorPayout(payable(_make()[1]));
        s.report(95);
        vm.warp(block.timestamp + 12);
        assertEq(s.due(), 2 * PHARMA_RATE);
    }

    receive() external payable { }
}
