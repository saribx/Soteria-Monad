// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { Custody } from "../src/Custody.sol";

contract CustodyTest is Test {
    Custody c;

    uint256 constant PK_SHIPPER = 0xA11CE;
    uint256 constant PK_CARRIER_A = 0xCA7A;
    uint256 constant PK_CARRIER_B = 0xCA7B;
    uint256 constant PK_RECEIVER = 0x7EC;
    uint256 constant PK_WAGON0 = 0x3A60;
    uint256 constant PK_WAGON1 = 0x3A61;
    uint256 constant PK_STRANGER = 0xBAD;

    bytes32 shipper;
    bytes32 carrierA;
    bytes32 carrierB;
    bytes32 receiver;
    bytes32 wagon0;
    bytes32 wagon1;

    uint256 constant ID = 7;
    uint64 constant PENALTY = 25_000; // 250.00 tEUR
    uint64 constant CAP = 40_000; // 400.00 tEUR
    uint16 constant LIMIT = 300; // 3.00 g

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_790_000_000);
        c = new Custody();
        shipper = _reg(PK_SHIPPER, 1, "Glaswerk Duisburg");
        carrierA = _reg(PK_CARRIER_A, 2, "Carrier A (DE)");
        carrierB = _reg(PK_CARRIER_B, 2, "Carrier B (PL)");
        receiver = _reg(PK_RECEIVER, 3, "Receiver Poznan");
        wagon0 = _reg(PK_WAGON0, 4, "Wagon 0");
        wagon1 = _reg(PK_WAGON1, 4, "Wagon 1");
        c.faucet(carrierA, 100_000);
        c.faucet(carrierB, 100_000);
    }

    // ---- helpers ---------------------------------------------------------------------------
    function _pub(uint256 pk) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 ux, uint256 uy) = vm.publicKeyP256(pk);
        return (bytes32(ux), bytes32(uy));
    }

    function _reg(uint256 pk, uint8 role, string memory name) internal returns (bytes32) {
        (bytes32 x, bytes32 y) = _pub(pk);
        return c.registerParty(x, y, role, name);
    }

    function _sign(uint256 pk, bytes memory message) internal pure returns (Custody.Sig memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(message));
        return Custody.Sig(r, s);
    }

    function _terms() internal view returns (Custody.Terms memory) {
        return Custody.Terms(shipper, carrierA, receiver, PENALTY, CAP, LIMIT, uint64(block.timestamp + 600));
    }

    function _wagons() internal view returns (bytes32[] memory w) {
        w = new bytes32[](2);
        w[0] = wagon0;
        w[1] = wagon1;
    }

    function _createMsg(uint256 id, Custody.Terms memory t, bytes32[] memory w) internal view returns (bytes memory) {
        return abi.encodePacked(
            block.chainid,
            address(c),
            uint8(1),
            id,
            t.shipper,
            t.carrier,
            t.receiver,
            t.penalty,
            t.cap,
            t.shockLimitCg,
            keccak256(abi.encodePacked(w)),
            t.expiry
        );
    }

    function _create() internal {
        Custody.Terms memory t = _terms();
        bytes32[] memory w = _wagons();
        c.createShipment(ID, t, w, _sign(PK_SHIPPER, _createMsg(ID, t, w)));
    }

    function _handoverMsg(uint32 epoch, bytes32 from, bytes32 to, uint64 expiry) internal view returns (bytes memory) {
        return abi.encodePacked(block.chainid, address(c), uint8(3), ID, epoch, from, to, bytes32("res-1"), expiry);
    }

    function _handover(uint32 epoch, bytes32 from, uint256 pkFrom, bytes32 to, uint256 pkTo) internal {
        uint64 exp = uint64(block.timestamp + 60);
        bytes memory m = _handoverMsg(epoch, from, to, exp);
        c.handover(ID, epoch, to, bytes32("res-1"), exp, _sign(pkFrom, m), _sign(pkTo, m));
    }

    function _batchMsg(uint8 wagon, uint32 epoch, uint64 seq, bytes32 root, uint8 status, bytes memory ct)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(block.chainid, address(c), uint8(2), ID, wagon, epoch, seq, root, status, sha256(ct));
    }

    function _alarmMsg(uint32 epoch, uint8 wagon, uint64 alarmId, uint16 v) internal view returns (bytes memory) {
        return abi.encodePacked(block.chainid, address(c), uint8(4), ID, epoch, wagon, alarmId, uint8(1), v);
    }

    function _alarm(uint32 epoch, uint64 alarmId, uint16 v) internal {
        c.alarm(ID, epoch, 0, alarmId, 1, v, _sign(PK_WAGON0, _alarmMsg(epoch, 0, alarmId, v)));
    }

    // ---- golden vector: WebCrypto signs raw bytes, contract hashes once ----------------------
    function test_goldenWebCryptoVector() public view {
        // Produced by contracts/tools/custody-golden.mjs with crypto.subtle.sign (the browser API).
        bytes memory message = hex"77686f2d6861642d697420676f6c64656e20766563746f723a207761676f6e20332c2073686f636b20353230206367";
        bytes32 x = 0xa2967740a4ac754148e8d97f1f8388827a840b2795927e8c3227e25f9fcd9ea1;
        bytes32 y = 0xac87d90a02c2d19f96cd30a346099c1c965cca5eead5c2b527448f5367b10b19;
        bytes32 r = 0xc0f8cb2a02c286e1d13e40d4e07ec02146635c825f324c12e877f3b1c06ea7a4;
        bytes32 s = 0x0220f3871fa3a667d8864adde03c404b59eec5a0f261e57b83f239095de63d39;
        assertTrue(c.checkSig(message, x, y, r, s), "webcrypto signature must verify");

        bytes memory tampered = bytes.concat(message, hex"00");
        assertFalse(c.checkSig(tampered, x, y, r, s), "tampered message must fail");
    }

    // ---- create ------------------------------------------------------------------------------
    function test_create() public {
        _create();
        (bytes32 sh,, bytes32 holder, uint32 epoch,,,,) = c.shipments(ID);
        assertEq(sh, shipper);
        assertEq(holder, carrierA);
        assertEq(epoch, 1);
        assertEq(c.wagonsOf(ID).length, 2);
    }

    function test_create_unregisteredShipper_reverts() public {
        (bytes32 x, bytes32 y) = _pub(PK_STRANGER);
        Custody.Terms memory t = _terms();
        t.shipper = c.keyOf(x, y);
        bytes32[] memory w = _wagons();
        Custody.Sig memory sig = _sign(PK_STRANGER, _createMsg(ID, t, w));
        vm.expectRevert(Custody.NotVerified.selector);
        c.createShipment(ID, t, w, sig);
    }

    function test_create_forged_reverts() public {
        Custody.Terms memory t = _terms();
        bytes32[] memory w = _wagons();
        Custody.Sig memory sig = _sign(PK_STRANGER, _createMsg(ID, t, w));
        vm.expectRevert(Custody.BadSignature.selector);
        c.createShipment(ID, t, w, sig);
    }

    function test_create_expired_reverts() public {
        Custody.Terms memory t = _terms();
        bytes32[] memory w = _wagons();
        Custody.Sig memory sig = _sign(PK_SHIPPER, _createMsg(ID, t, w));
        vm.warp(t.expiry + 1);
        vm.expectRevert(Custody.Expired.selector);
        c.createShipment(ID, t, w, sig);
    }

    function test_create_twice_reverts() public {
        _create();
        Custody.Terms memory t = _terms();
        bytes32[] memory w = _wagons();
        Custody.Sig memory sig = _sign(PK_SHIPPER, _createMsg(ID, t, w));
        vm.expectRevert(Custody.ShipmentExists.selector);
        c.createShipment(ID, t, w, sig);
    }

    // ---- handover ----------------------------------------------------------------------------
    function test_handover() public {
        _create();
        _handover(1, carrierA, PK_CARRIER_A, carrierB, PK_CARRIER_B);
        (,, bytes32 holder, uint32 epoch,,,,) = c.shipments(ID);
        assertEq(holder, carrierB);
        assertEq(epoch, 2);
    }

    function test_handover_staleEpoch_reverts() public {
        _create();
        _handover(1, carrierA, PK_CARRIER_A, carrierB, PK_CARRIER_B);
        uint64 exp = uint64(block.timestamp + 60);
        bytes memory m = _handoverMsg(1, carrierA, carrierB, exp);
        Custody.Sig memory a = _sign(PK_CARRIER_A, m);
        Custody.Sig memory b = _sign(PK_CARRIER_B, m);
        vm.expectRevert(Custody.StaleEpoch.selector);
        c.handover(ID, 1, carrierB, bytes32("res-1"), exp, a, b);
    }

    function test_handover_toUnregistered_reverts() public {
        _create();
        (bytes32 x, bytes32 y) = _pub(PK_STRANGER);
        bytes32 stranger = c.keyOf(x, y);
        uint64 exp = uint64(block.timestamp + 60);
        bytes memory m = _handoverMsg(1, carrierA, stranger, exp);
        Custody.Sig memory a = _sign(PK_CARRIER_A, m);
        Custody.Sig memory b = _sign(PK_STRANGER, m);
        vm.expectRevert(Custody.NotVerified.selector);
        c.handover(ID, 1, stranger, bytes32("res-1"), exp, a, b);
    }

    function test_handover_receiverDidNotSign_reverts() public {
        _create();
        uint64 exp = uint64(block.timestamp + 60);
        bytes memory m = _handoverMsg(1, carrierA, carrierB, exp);
        Custody.Sig memory a = _sign(PK_CARRIER_A, m);
        vm.expectRevert(Custody.BadSignature.selector);
        c.handover(ID, 1, carrierB, bytes32("res-1"), exp, a, a);
    }

    // ---- batches -----------------------------------------------------------------------------
    function test_batch_updatesHead() public {
        _create();
        bytes memory ct = hex"deadbeefcafe";
        bytes32 root = keccak256("readings");
        bytes memory m = _batchMsg(0, 1, 1, root, 0, ct);
        c.commitBatch(ID, 0, 1, 1, root, 0, ct, _sign(PK_WAGON0, m));
        assertEq(c.head(ID), keccak256(abi.encodePacked(bytes32(0), root, sha256(ct))));
        assertEq(c.lastSeq(ID, 0), 1);
    }

    function test_batch_replay_reverts() public {
        _create();
        bytes memory ct = hex"01";
        bytes memory m = _batchMsg(0, 1, 1, bytes32(0), 0, ct);
        Custody.Sig memory sig = _sign(PK_WAGON0, m);
        c.commitBatch(ID, 0, 1, 1, bytes32(0), 0, ct, sig);
        vm.expectRevert(Custody.Replay.selector);
        c.commitBatch(ID, 0, 1, 1, bytes32(0), 0, ct, sig);
    }

    function test_batch_forged_reverts() public {
        _create();
        bytes memory ct = hex"01";
        // "all fine" reading signed by a key that is not wagon 0
        Custody.Sig memory sig = _sign(PK_STRANGER, _batchMsg(0, 1, 1, bytes32(0), 0, ct));
        vm.expectRevert(Custody.BadSignature.selector);
        c.commitBatch(ID, 0, 1, 1, bytes32(0), 0, ct, sig);
    }

    function test_batch_ciphertextSwap_reverts() public {
        _create();
        Custody.Sig memory sig = _sign(PK_WAGON0, _batchMsg(0, 1, 1, bytes32(0), 0, hex"01"));
        vm.expectRevert(Custody.BadSignature.selector);
        c.commitBatch(ID, 0, 1, 1, bytes32(0), 0, hex"02", sig);
    }

    function test_batch_wagon1_independentSeq() public {
        _create();
        c.commitBatch(ID, 0, 1, 5, bytes32(0), 0, hex"01", _sign(PK_WAGON0, _batchMsg(0, 1, 5, bytes32(0), 0, hex"01")));
        c.commitBatch(ID, 1, 1, 1, bytes32(0), 1, hex"01", _sign(PK_WAGON1, _batchMsg(1, 1, 1, bytes32(0), 1, hex"01")));
        assertEq(c.lastSeq(ID, 1), 1);
    }

    // ---- alarms & settlement -----------------------------------------------------------------
    function test_alarm_chargesHolderOfEpoch() public {
        _create();
        _handover(1, carrierA, PK_CARRIER_A, carrierB, PK_CARRIER_B);
        _alarm(2, 1, 520);
        assertEq(c.balanceOf(carrierB), 100_000 - PENALTY);
        assertEq(c.balanceOf(carrierA), 100_000);
        assertEq(c.balanceOf(shipper), PENALTY);
    }

    function test_alarm_staleEpoch_reverts() public {
        _create();
        bytes memory m = _alarmMsg(1, 0, 1, 520); // signed during epoch 1
        Custody.Sig memory sig = _sign(PK_WAGON0, m);
        _handover(1, carrierA, PK_CARRIER_A, carrierB, PK_CARRIER_B);
        vm.expectRevert(Custody.StaleEpoch.selector);
        c.alarm(ID, 1, 0, 1, 1, 520, sig);
    }

    function test_alarm_belowLimit_reverts() public {
        _create();
        Custody.Sig memory sig = _sign(PK_WAGON0, _alarmMsg(1, 0, 1, 200));
        vm.expectRevert(Custody.BelowLimit.selector);
        c.alarm(ID, 1, 0, 1, 1, 200, sig);
    }

    function test_alarm_replay_reverts() public {
        _create();
        _alarm(1, 9, 520);
        Custody.Sig memory sig = _sign(PK_WAGON0, _alarmMsg(1, 0, 9, 520));
        vm.expectRevert(Custody.Replay.selector);
        c.alarm(ID, 1, 0, 9, 1, 520, sig);
    }

    function test_alarm_forged_reverts() public {
        _create();
        Custody.Sig memory sig = _sign(PK_STRANGER, _alarmMsg(1, 0, 1, 520));
        vm.expectRevert(Custody.BadSignature.selector);
        c.alarm(ID, 1, 0, 1, 1, 520, sig);
    }

    function test_alarm_cappedPerShipment() public {
        _create();
        _alarm(1, 1, 520);
        _alarm(1, 2, 520);
        _alarm(1, 3, 520);
        assertEq(c.balanceOf(shipper), CAP);
        (,,,,,,, uint64 paid) = c.shipments(ID);
        assertEq(paid, CAP);
    }

    function test_alarm_cappedByBalance() public {
        (bytes32 x, bytes32 y) = _pub(0xC0FFEE);
        bytes32 poor = c.registerParty(x, y, 2, "Poor carrier");
        c.faucet(poor, 1_000);
        Custody.Terms memory t = _terms();
        t.carrier = poor;
        bytes32[] memory w = _wagons();
        c.createShipment(ID, t, w, _sign(PK_SHIPPER, _createMsg(ID, t, w)));
        _alarm(1, 1, 520);
        assertEq(c.balanceOf(poor), 0);
        assertEq(c.balanceOf(shipper), 1_000);
    }

    function test_alarm_afterDelivery_reverts() public {
        _create();
        _handover(1, carrierA, PK_CARRIER_A, receiver, PK_RECEIVER);
        Custody.Sig memory sig = _sign(PK_WAGON0, _alarmMsg(2, 0, 1, 520));
        vm.expectRevert(Custody.Delivered.selector);
        c.alarm(ID, 2, 0, 1, 1, 520, sig);
    }

    // ---- wrapped keys ------------------------------------------------------------------------
    function test_postKeys() public {
        _create();
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = shipper;
        keys[1] = receiver;
        bytes[] memory wrapped = new bytes[](2);
        wrapped[0] = hex"aa";
        wrapped[1] = hex"bb";
        bytes memory m = abi.encodePacked(
            block.chainid, address(c), uint8(5), ID, uint32(1), shipper, keccak256(abi.encode(keys, wrapped))
        );
        vm.expectEmit(true, true, false, true);
        emit Custody.KeyWrapped(ID, 1, shipper, hex"aa");
        c.postKeys(ID, 1, shipper, keys, wrapped, _sign(PK_SHIPPER, m));
    }

    function test_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(Custody.NotOwner.selector);
        c.faucet(shipper, 1);
    }
}
