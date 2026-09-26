// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SoteriaRail, IERC20Like} from "../src/SoteriaRail.sol";
import {TEUR} from "../src/TEUR.sol";

contract SoteriaRailTest is Test {
    TEUR teur;
    SoteriaRail rail;

    address carrier = makeAddr("carrier");
    address customer = makeAddr("customer");
    address reefer = makeAddr("reefer-W02");
    address tank = makeAddr("tank-W05");
    address loco = makeAddr("loco");
    address anyone = makeAddr("anyone");

    uint256 constant EUR = 1e18;
    uint32 sid;
    uint32 constant W_REEFER = 1;
    uint32 constant W_TANK = 2;
    uint32 constant W_LOCO = 3;

    function setUp() public {
        vm.warp(1_000_000);
        teur = new TEUR();
        rail = new SoteriaRail(IERC20Like(address(teur)));
        teur.mint(carrier, 10_000_000 * EUR);
        vm.startPrank(carrier);
        teur.approve(address(rail), type(uint256).max);
        rail.fundPool(1_000_000);
        vm.stopPrank();
        sid = _book();
        vm.prank(customer);
        rail.accept(sid);
    }

    function _book() internal returns (uint32) {
        SoteriaRail.Terms memory t = SoteriaRail.Terms({
            customer: customer,
            bondEur: 30_000,
            delayPenaltyEur: 18_000,
            liabilityCapEur: 250_000,
            deadline: uint40(block.timestamp + 1 days),
            maxStandstill: 20,
            gapAfter: 30,
            challengeWindow: 45,
            ref: bytes16("S1")
        });
        SoteriaRail.WagonInput[] memory ws = new SoteriaRail.WagonInput[](3);
        ws[0] = SoteriaRail.WagonInput(reefer, 1, -250, -150, 0, 0, 6_000, 20, 10, bytes16("TR-1001/W02"));
        ws[1] = SoteriaRail.WagonInput(tank, 2, 0, 0, 380, 200, 0, 0, 0, bytes16("TR-1001/W05"));
        ws[2] = SoteriaRail.WagonInput(loco, 3, 0, 0, 0, 0, 0, 0, 0, bytes16("TR-1001/LOCO"));
        vm.prank(carrier);
        return rail.book(t, ws);
    }

    function _pack(int16 last, int16 mn, int16 mx, uint16 pressure, uint16 shock, uint8 flags)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(
            uint256(uint16(last)) | uint256(uint16(mn)) << 16 | uint256(uint16(mx)) << 32 | uint256(pressure) << 48
                | uint256(shock) << 64 | uint256(flags) << 96
        );
    }

    function _temp(int16 t) internal {
        vm.prank(reefer);
        rail.report(_pack(t, t, t, 0, 10, 0));
    }

    function _balance() internal view returns (uint256) {
        return teur.balanceOf(customer) / EUR;
    }

    // ------------------------------------------------------------------ booking

    function test_bookLocksBondAndBindsDevicesOnAccept() public view {
        assertEq(teur.balanceOf(address(rail)), (30_000 + 1_000_000) * EUR);
        assertEq(rail.deviceWagon(reefer), W_REEFER);
        assertEq(rail.deviceWagon(loco), W_LOCO);
    }

    function test_devicesDoNotCountBeforeAccept() public {
        vm.prank(customer);
        rail.close(sid);
        uint32 second = _book();
        vm.prank(reefer);
        vm.expectRevert(SoteriaRail.NotADevice.selector);
        rail.report(_pack(-180, -180, -180, 0, 0, 0));
        vm.prank(customer);
        rail.accept(second);
        _temp(-180);
    }

    function test_deviceCannotServeTwoShipments() public {
        uint32 second = _book();
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(SoteriaRail.DeviceBusy.selector, reefer));
        rail.accept(second);
    }

    function test_onlyTheBoundDeviceReports() public {
        vm.prank(anyone);
        vm.expectRevert(SoteriaRail.NotADevice.selector);
        rail.report(_pack(-180, -180, -180, 0, 0, 0));
    }

    // ------------------------------------------------------------------ cold chain

    function test_readingInRangeMovesNoMoney() public {
        _temp(-182);
        (uint40 lastSeen, uint40 start,,,,,) = rail.states(W_REEFER);
        assertEq(lastSeen, block.timestamp);
        assertEq(start, 0);
        assertEq(_balance(), 0);
    }

    function test_shortExcursionWithinGraceIsFree() public {
        _temp(-140);
        vm.warp(block.timestamp + 8);
        _temp(-170);
        assertEq(_balance(), 0);
    }

    function test_excursionPaysPerSecondBeyondGrace() public {
        _temp(-140);
        vm.warp(block.timestamp + 25);
        assertEq(rail.accruedEur(W_REEFER), (25 - 10) * 20);
        _temp(-160);
        assertEq(_balance(), 300);
        (,, uint32 paid,,,,) = rail.states(W_REEFER);
        assertEq(paid, 300);
    }

    function test_spikeInsideTheWindowCounts() public {
        // last and min in range, but the max of the window was not
        vm.prank(reefer);
        rail.report(_pack(-170, -180, -140, 0, 0, 0));
        (, uint40 start,,,,,) = rail.states(W_REEFER);
        assertEq(start, block.timestamp);
    }

    function test_excursionStopsAtTheWagonCap() public {
        _temp(-120);
        vm.warp(block.timestamp + 10 + 300);
        _temp(-100); // still out, cap of 6,000 reached: settles at once
        assertEq(_balance(), 6_000);
        vm.warp(block.timestamp + 100);
        _temp(-100);
        _temp(-180);
        assertEq(_balance(), 6_000);
    }

    function test_silenceCountsAsOutOfRange() public {
        uint256 seen = 2_000_000;
        vm.warp(seen);
        _temp(-180);
        vm.warp(seen + 20);
        vm.expectRevert(SoteriaRail.NoGap.selector);
        rail.checkGap(W_REEFER);

        vm.warp(seen + 31);
        vm.prank(anyone);
        rail.checkGap(W_REEFER);
        (, uint40 start,,,,,) = rail.states(W_REEFER);
        assertEq(start, seen);

        vm.warp(seen + 40);
        _temp(-180); // back, in range: the silence is paid
        assertEq(_balance(), (40 - 10) * 20);
    }

    // ------------------------------------------------------------------ hazmat

    function test_tankRaisesEachAlertOnceAndPaysNothing() public {
        vm.expectEmit(true, false, false, true);
        emit SoteriaRail.SafetyAlert(W_TANK, 1, 260);
        vm.prank(tank);
        rail.report(_pack(130, 130, 130, 420, 260, 0));

        vm.expectEmit(true, false, false, true);
        emit SoteriaRail.SafetyAlert(W_TANK, 2, 370);
        vm.prank(tank);
        rail.report(_pack(130, 130, 130, 370, 30, 0));

        vm.recordLogs();
        vm.prank(tank);
        rail.report(_pack(130, 130, 130, 360, 300, 0));
        assertEq(vm.getRecordedLogs().length, 1); // only the Reading
        assertEq(_balance(), 0);
    }

    // ------------------------------------------------------------------ delay

    function _stopTrain() internal {
        vm.prank(loco);
        rail.report(_pack(0, 0, 0, 0, 0, 2));
    }

    function test_standstillBeyondSlackAccruesDelay() public {
        _stopTrain();
        vm.warp(block.timestamp + 10);
        vm.expectRevert(SoteriaRail.NotDelayed.selector);
        rail.flagDelay(sid);
        vm.warp(block.timestamp + 11);
        vm.prank(anyone);
        rail.flagDelay(sid);
        (,,,,,,,,,,, uint40 delayAt, uint8 state,,,,,) = rail.shipments(sid);
        assertEq(state, 1);
        assertEq(delayAt, block.timestamp);
    }

    function test_trainMovingAgainClearsStandstill() public {
        _stopTrain();
        vm.warp(block.timestamp + 5);
        vm.prank(loco);
        rail.report(_pack(0, 0, 0, 0, 0, 0));
        vm.warp(block.timestamp + 60);
        vm.expectRevert(SoteriaRail.NotDelayed.selector);
        rail.flagDelay(sid);
    }

    function test_undisputedDelayPaysAfterTheWindow() public {
        _stopTrain();
        vm.warp(block.timestamp + 21);
        rail.flagDelay(sid);
        vm.expectRevert(SoteriaRail.WindowOpen.selector);
        rail.settleDelay(sid);
        vm.warp(block.timestamp + 46);
        vm.prank(anyone);
        rail.settleDelay(sid);
        assertEq(_balance(), 18_000);
    }

    function test_lateArrivalAccruesDelay() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(loco);
        rail.report(_pack(0, 0, 0, 0, 0, 1));
        (,,,,,,,,,,, uint40 delayAt, uint8 state,,,,,) = rail.shipments(sid);
        assertEq(state, 1);
        assertEq(delayAt, block.timestamp);
    }

    function test_disputeFreezesThePenalty() public {
        _stopTrain();
        vm.warp(block.timestamp + 21);
        rail.flagDelay(sid);
        vm.prank(customer);
        vm.expectRevert(SoteriaRail.NotParty.selector);
        rail.disputeDelay(sid, "force majeure");
        vm.prank(carrier);
        rail.disputeDelay(sid, "force majeure");
        vm.warp(block.timestamp + 100);
        vm.expectRevert(SoteriaRail.BadState.selector);
        rail.settleDelay(sid);
        assertEq(_balance(), 0);
    }

    function test_disputeAfterTheWindowIsTooLate() public {
        _stopTrain();
        vm.warp(block.timestamp + 21);
        rail.flagDelay(sid);
        vm.warp(block.timestamp + 46);
        vm.prank(carrier);
        vm.expectRevert(SoteriaRail.WindowClosed.selector);
        rail.disputeDelay(sid, "force majeure");
    }

    // ------------------------------------------------------------------ settlements

    function test_settlementNeedsBothSignaturesAndWaivesTheDelay() public {
        _stopTrain();
        vm.warp(block.timestamp + 21);
        rail.flagDelay(sid);
        vm.prank(carrier);
        rail.disputeDelay(sid, "force majeure");

        vm.prank(carrier);
        uint32 cid = rail.proposeSettlement(sid, 24_000, true, bytes16("TR-1001/W03"), bytes32(uint256(0x041d)));
        assertEq(_balance(), 0);

        vm.prank(anyone);
        vm.expectRevert(SoteriaRail.NotParty.selector);
        rail.sign(cid);

        vm.prank(customer);
        rail.sign(cid);
        assertEq(_balance(), 24_000);
        assertEq(rail.poolEur(carrier), 1_000_000 - 24_000);
        (,,,,,,,,,,,, uint8 state,,,,,) = rail.shipments(sid);
        assertEq(state, 4);
    }

    function test_settlementRespectsTheLiabilityCap() public {
        vm.prank(customer);
        uint32 cid = rail.proposeSettlement(sid, 250_001, false, bytes16("x"), bytes32(0));
        vm.prank(carrier);
        vm.expectRevert(SoteriaRail.OverCap.selector);
        rail.sign(cid);
    }

    // ------------------------------------------------------------------ close

    function test_carrierCannotCloseBeforeArrival() public {
        vm.prank(carrier);
        vm.expectRevert(SoteriaRail.BadState.selector);
        rail.close(sid);
    }

    function test_closeSettlesOpenExcursionsAndReturnsTheBond() public {
        _temp(-140);
        vm.warp(block.timestamp + 20);
        uint256 before = teur.balanceOf(carrier);
        vm.prank(customer);
        rail.close(sid);
        assertEq(_balance(), 200);
        assertEq(teur.balanceOf(carrier) - before, (30_000 - 200) * EUR);
        assertEq(rail.deviceWagon(reefer), 0);
    }

    // ------------------------------------------------------------------ gas

    function test_gas_reading() public {
        _temp(-181);
        vm.warp(block.timestamp + 1);
        vm.prank(reefer);
        uint256 g = gasleft();
        rail.report(_pack(-182, -183, -181, 0, 10, 0));
        emit log_named_uint("report, in range", g - gasleft());

        vm.warp(block.timestamp + 1);
        vm.prank(reefer);
        g = gasleft();
        rail.report(_pack(-140, -140, -140, 0, 10, 0));
        emit log_named_uint("report, excursion starts", g - gasleft());

        vm.warp(block.timestamp + 30);
        vm.prank(reefer);
        g = gasleft();
        rail.report(_pack(-170, -170, -170, 0, 10, 0));
        emit log_named_uint("report, excursion settles", g - gasleft());
    }
}
