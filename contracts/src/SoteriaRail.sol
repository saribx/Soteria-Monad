// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title SoteriaRail
/// @notice Freight shipments whose sensor readings settle the contract.
///
/// Every monitored wagon has its own device key. `report()` takes one packed
/// reading from that key and writes only that wagon's state slot, so readings
/// from different wagons never conflict and Monad executes them in parallel.
/// There are no global counters on the hot path. Money moves only when an
/// excursion settles, never on a plain reading.
///
/// Automatic payouts cover physical facts only: temperature out of range, a
/// silent sensor, a lost delivery slot once the challenge window has passed.
/// Anything that needs judgement (force majeure, the extent of damage) is paid
/// only when carrier and customer have both signed.
///
/// Nothing on chain names a place, a company or the goods: shipments and wagons
/// carry pseudonymous references, readings carry physics.
contract SoteriaRail {
    // ---- sensor kinds
    uint8 public constant REEFER = 1; // temperature-controlled: automatic compensation
    uint8 public constant TANK = 2; // hazmat tank: safety alerts, no automatic payout
    uint8 public constant LOCO = 3; // locomotive: arrival and standstill

    // ---- reading flags (locomotive)
    uint8 public constant FLAG_ARRIVED = 1;
    uint8 public constant FLAG_STOPPED = 2;

    // ---- safety alert codes
    uint8 public constant ALERT_SHOCK = 1;
    uint8 public constant ALERT_PRESSURE = 2;

    // ---- shipment status
    uint8 public constant BOOKED = 1;
    uint8 public constant ACTIVE = 2;
    uint8 public constant CLOSED = 3;

    // ---- delay state
    uint8 public constant DELAY_NONE = 0;
    uint8 public constant DELAY_ACCRUED = 1;
    uint8 public constant DELAY_DISPUTED = 2;
    uint8 public constant DELAY_PAID = 3;
    uint8 public constant DELAY_WAIVED = 4;

    // ---- payout reasons
    uint8 public constant PAY_EXCURSION = 1;
    uint8 public constant PAY_DELAY = 2;
    uint8 public constant PAY_SETTLEMENT = 3;

    uint256 private constant EUR = 1e18;

    struct Terms {
        address customer;
        uint32 bondEur; // sized to the automatic exposure, not to the liability cap
        uint32 delayPenaltyEur;
        uint32 liabilityCapEur; // ceiling for signed settlements
        uint40 deadline; // delivery deadline (unix seconds)
        uint32 maxStandstill; // seconds an unplanned stop may last before the slot is lost
        uint32 gapAfter; // seconds of silence after which a monitored wagon counts as out of range
        uint32 challengeWindow; // seconds the carrier has to dispute a delay
        bytes16 ref;
    }

    struct WagonInput {
        address device;
        uint8 kind;
        int16 tMin; // 0.1 °C
        int16 tMax; // 0.1 °C
        uint16 pMin; // 0.01 bar
        uint16 shockMax; // 0.01 g
        uint32 capEur; // ceiling for automatic payouts on this wagon
        uint32 rateEur; // EUR per second out of range after the grace period
        uint32 graceSec;
        bytes16 ref;
    }

    struct Shipment {
        address carrier;
        uint32 bondEur; // what is left of the bond
        uint32 firstWagon;
        uint8 wagonCount;
        uint8 status;
        address customer;
        uint32 delayPenaltyEur;
        uint32 liabilityCapEur;
        uint40 deadline;
        uint40 arrivedAt;
        uint40 stoppedAt;
        uint40 delayAt;
        uint8 delayState;
        uint32 maxStandstill;
        uint32 gapAfter;
        uint32 challengeWindow;
        uint32 claimedEur;
        bytes16 ref;
    }

    struct Wagon {
        address device;
        uint32 shipment;
        uint8 kind;
        int16 tMin;
        int16 tMax;
        uint16 pMin;
        uint16 shockMax;
        uint32 capEur;
        uint32 rateEur;
        uint32 graceSec;
        bytes16 ref;
    }

    /// The only slot a reading writes.
    struct WagonState {
        uint40 lastSeen;
        uint40 excursionStart; // 0: in range
        uint32 paidEur;
        uint8 alerts; // bit per alert code, each alert is raised once
        bool capped;
        int16 lastTemp;
        uint16 lastPressure;
    }

    struct Settlement {
        uint32 shipment;
        uint32 amountEur;
        bool waiveDelay;
        bool carrierSigned;
        bool customerSigned;
        bool executed;
        bytes16 ref;
        bytes32 evidence; // head of the Soteria receipt chain
    }

    IERC20Like public immutable token;

    uint32 public shipmentCount;
    uint32 public wagonCount;
    uint32 public settlementCount;

    mapping(uint32 => Shipment) public shipments;
    mapping(uint32 => Wagon) public wagons;
    mapping(uint32 => WagonState) public states;
    mapping(address => uint32) public deviceWagon; // active binding, 0 = none
    mapping(address => uint256) public poolEur; // carrier liability pool
    mapping(uint32 => Settlement) public settlements;

    event Booked(uint32 indexed shipment, address indexed carrier, address indexed customer, bytes16 ref, uint32 bondEur, uint40 deadline);
    event WagonRegistered(uint32 indexed wagon, uint32 indexed shipment, uint8 kind, address device, bytes16 ref);
    event Accepted(uint32 indexed shipment);
    event Closed(uint32 indexed shipment, uint32 bondReturnedEur);
    event Reading(uint32 indexed wagon, bytes32 data);
    event ExcursionStarted(uint32 indexed wagon, int16 temp, bool gap);
    event ExcursionEnded(uint32 indexed wagon, uint32 secondsOut, uint32 paidEur, bool capped);
    event MonitoringGap(uint32 indexed wagon, uint40 lastSeen);
    event SafetyAlert(uint32 indexed wagon, uint8 code, uint16 value);
    event Arrived(uint32 indexed shipment, bool late);
    event Standstill(uint32 indexed shipment, bool stopped);
    event DelayAccrued(uint32 indexed shipment, uint32 penaltyEur, uint40 challengeUntil);
    event DelayDisputed(uint32 indexed shipment, bytes32 reason);
    event DelayResolved(uint32 indexed shipment, uint8 state);
    event Payout(uint32 indexed shipment, uint32 indexed wagon, address to, uint32 amountEur, uint8 reason);
    event DecisionAnchored(uint32 indexed shipment, bytes16 incident, bytes32 receiptHead, uint8 tier, uint8 keys);
    event SettlementProposed(uint32 indexed settlement, uint32 indexed shipment, uint32 amountEur, bool waiveDelay, bytes16 ref, bytes32 evidence);
    event SettlementSigned(uint32 indexed settlement, address signer);
    event SettlementExecuted(uint32 indexed settlement);
    event PoolFunded(address indexed carrier, uint256 amountEur);

    error BadInput();
    error NotParty();
    error BadState();
    error NotADevice();
    error NotActive();
    error DeviceBusy(address device);
    error NoGap();
    error NotDelayed();
    error WindowClosed();
    error WindowOpen();
    error OverCap();
    error PoolEmpty();
    error TransferFailed();

    constructor(IERC20Like token_) {
        token = token_;
    }

    // ------------------------------------------------------------------ booking

    /// @notice The carrier books a shipment and locks the bond. The devices only
    /// count once the customer has accepted the terms and the device keys.
    function book(Terms calldata t, WagonInput[] calldata ws) external returns (uint32 sid) {
        if (ws.length == 0 || ws.length > 255) revert BadInput();
        if (t.customer == address(0) || t.customer == msg.sender) revert BadInput();

        sid = ++shipmentCount;
        Shipment storage sh = shipments[sid];
        sh.carrier = msg.sender;
        sh.customer = t.customer;
        sh.bondEur = t.bondEur;
        sh.firstWagon = wagonCount + 1;
        sh.wagonCount = uint8(ws.length);
        sh.status = BOOKED;
        sh.delayPenaltyEur = t.delayPenaltyEur;
        sh.liabilityCapEur = t.liabilityCapEur;
        sh.deadline = t.deadline;
        sh.maxStandstill = t.maxStandstill;
        sh.gapAfter = t.gapAfter;
        sh.challengeWindow = t.challengeWindow;
        sh.ref = t.ref;

        for (uint256 i; i < ws.length; ++i) {
            WagonInput calldata input = ws[i];
            if (input.device == address(0) || input.kind == 0 || input.kind > LOCO) revert BadInput();
            uint32 id = ++wagonCount;
            wagons[id] = Wagon({
                device: input.device,
                shipment: sid,
                kind: input.kind,
                tMin: input.tMin,
                tMax: input.tMax,
                pMin: input.pMin,
                shockMax: input.shockMax,
                capEur: input.capEur,
                rateEur: input.rateEur,
                graceSec: input.graceSec,
                ref: input.ref
            });
            emit WagonRegistered(id, sid, input.kind, input.device, input.ref);
        }

        _pull(msg.sender, t.bondEur);
        emit Booked(sid, msg.sender, t.customer, t.ref, t.bondEur, t.deadline);
    }

    /// @notice The customer accepts terms and device keys. Monitoring starts now.
    function accept(uint32 sid) external {
        Shipment storage sh = shipments[sid];
        if (msg.sender != sh.customer) revert NotParty();
        if (sh.status != BOOKED) revert BadState();
        uint32 end = sh.firstWagon + sh.wagonCount;
        for (uint32 id = sh.firstWagon; id < end; ++id) {
            address device = wagons[id].device;
            if (deviceWagon[device] != 0) revert DeviceBusy(device);
            deviceWagon[device] = id;
            states[id].lastSeen = uint40(block.timestamp);
        }
        sh.status = ACTIVE;
        emit Accepted(sid);
    }

    /// @notice Ends a shipment and returns what is left of the bond to the carrier.
    /// Open excursions are settled first. The customer may close at any time;
    /// the carrier only after arrival with no delay still open.
    function close(uint32 sid) external {
        Shipment storage sh = shipments[sid];
        uint8 status = sh.status;
        if (status != BOOKED && status != ACTIVE) revert BadState();
        if (msg.sender != sh.customer) {
            if (msg.sender != sh.carrier) revert NotParty();
            if (
                status == ACTIVE
                    && (sh.arrivedAt == 0 || sh.delayState == DELAY_ACCRUED || sh.delayState == DELAY_DISPUTED)
            ) revert BadState();
        }

        if (status == ACTIVE) {
            uint32 end = sh.firstWagon + sh.wagonCount;
            uint40 nowTs = uint40(block.timestamp);
            for (uint32 id = sh.firstWagon; id < end; ++id) {
                Wagon storage w = wagons[id];
                WagonState memory s = states[id];
                if (s.excursionStart != 0) {
                    _settle(id, w, s, nowTs);
                    states[id] = s;
                }
                if (deviceWagon[w.device] == id) delete deviceWagon[w.device];
            }
        }

        sh.status = CLOSED;
        uint32 rest = sh.bondEur;
        sh.bondEur = 0;
        if (rest > 0) _send(sh.carrier, rest);
        emit Closed(sid, rest);
    }

    // ------------------------------------------------------------------ readings

    /// @notice One reading from a device. Layout of `data`, from the low bits:
    ///   0 int16 last temp (0.1 °C) | 16 int16 min temp | 32 int16 max temp
    ///  48 uint16 pressure (0.01 bar) | 64 uint16 peak shock (0.01 g)
    ///  80 uint16 speed (0.1 km/h) | 96 uint8 flags | 104 uint16 window (0.1 s)
    /// Min, max and peak cover the whole window since the previous reading,
    /// so nothing between two heartbeats is lost.
    function report(bytes32 data) external {
        uint32 id = deviceWagon[msg.sender];
        if (id == 0) revert NotADevice();
        Wagon storage w = wagons[id];
        WagonState memory s = states[id];
        uint256 r = uint256(data);
        uint40 nowTs = uint40(block.timestamp);
        uint8 kind = w.kind;

        if (kind == REEFER) {
            int16 tMin = int16(uint16(r >> 16));
            int16 tMax = int16(uint16(r >> 32));
            s.lastTemp = int16(uint16(r));
            bool out = tMin < w.tMin || tMax > w.tMax;
            if (out) {
                if (s.excursionStart == 0) {
                    if (!s.capped) {
                        s.excursionStart = nowTs;
                        emit ExcursionStarted(id, tMax > w.tMax ? tMax : tMin, false);
                    }
                } else if (_due(w, s, nowTs) >= w.capEur - s.paidEur) {
                    _settle(id, w, s, nowTs);
                }
            } else if (s.excursionStart != 0) {
                _settle(id, w, s, nowTs);
            }
        } else if (kind == TANK) {
            uint16 pressure = uint16(r >> 48);
            uint16 shock = uint16(r >> 64);
            s.lastTemp = int16(uint16(r));
            s.lastPressure = pressure;
            if (shock > w.shockMax && s.alerts & 1 == 0) {
                s.alerts |= 1;
                emit SafetyAlert(id, ALERT_SHOCK, shock);
            }
            if (pressure < w.pMin && s.alerts & 2 == 0) {
                s.alerts |= 2;
                emit SafetyAlert(id, ALERT_PRESSURE, pressure);
            }
        } else {
            _locomotive(w.shipment, uint8(r >> 96), nowTs);
        }

        s.lastSeen = nowTs;
        states[id] = s;
        emit Reading(id, data);
    }

    /// @notice Anyone may flag a silent device. For a reefer the silence counts
    /// as out of range from the last reading on: no data, no proof of integrity.
    function checkGap(uint32 id) external {
        Wagon storage w = wagons[id];
        if (w.device == address(0) || deviceWagon[w.device] != id) revert NotActive();
        WagonState memory s = states[id];
        if (block.timestamp <= uint256(s.lastSeen) + shipments[w.shipment].gapAfter) revert NoGap();
        if (w.kind == REEFER && !s.capped) {
            if (s.excursionStart == 0) {
                s.excursionStart = s.lastSeen;
                emit ExcursionStarted(id, s.lastTemp, true);
            } else if (_due(w, s, uint40(block.timestamp)) >= w.capEur - s.paidEur) {
                _settle(id, w, s, uint40(block.timestamp));
            }
            states[id] = s;
        }
        emit MonitoringGap(id, s.lastSeen);
    }

    // ------------------------------------------------------------------ delay

    /// @notice Anyone may flag a delay once the deadline has passed without
    /// arrival, or once an unplanned stop has outlasted the timetable's slack.
    function flagDelay(uint32 sid) external {
        Shipment storage sh = shipments[sid];
        if (sh.status != ACTIVE || sh.delayState != DELAY_NONE) revert BadState();
        bool late = sh.arrivedAt == 0 && block.timestamp > sh.deadline;
        bool stuck = sh.stoppedAt != 0 && block.timestamp > uint256(sh.stoppedAt) + sh.maxStandstill;
        if (!late && !stuck) revert NotDelayed();
        _accrueDelay(sid, sh);
    }

    /// @notice Force majeure is a legal question, not a sensor fact: the carrier
    /// may dispute within the window, which freezes the penalty until both sign.
    function disputeDelay(uint32 sid, bytes32 reason) external {
        Shipment storage sh = shipments[sid];
        if (msg.sender != sh.carrier) revert NotParty();
        if (sh.delayState != DELAY_ACCRUED) revert BadState();
        if (block.timestamp > uint256(sh.delayAt) + sh.challengeWindow) revert WindowClosed();
        sh.delayState = DELAY_DISPUTED;
        emit DelayDisputed(sid, reason);
    }

    /// @notice Anyone may settle an undisputed delay once the window has passed.
    function settleDelay(uint32 sid) external {
        Shipment storage sh = shipments[sid];
        if (sh.delayState != DELAY_ACCRUED) revert BadState();
        if (block.timestamp <= uint256(sh.delayAt) + sh.challengeWindow) revert WindowOpen();
        sh.delayState = DELAY_PAID;
        _payFromBond(sid, sh.delayPenaltyEur, 0, PAY_DELAY);
        emit DelayResolved(sid, DELAY_PAID);
    }

    // ------------------------------------------------------------------ judgement

    /// @notice Anchors a Soteria decision: the head of its receipt chain, the
    /// approval tier and how many human keys approved it.
    function anchorDecision(uint32 sid, bytes16 incident, bytes32 receiptHead, uint8 tier, uint8 keys) external {
        if (msg.sender != shipments[sid].carrier) revert NotParty();
        emit DecisionAnchored(sid, incident, receiptHead, tier, keys);
    }

    /// @notice Proposes a settlement for what a sensor cannot decide. Paid from
    /// the carrier's liability pool once both parties have signed.
    function proposeSettlement(uint32 sid, uint32 amountEur, bool waiveDelay, bytes16 ref, bytes32 evidence)
        external
        returns (uint32 cid)
    {
        Shipment storage sh = shipments[sid];
        bool isCarrier = msg.sender == sh.carrier;
        if (!isCarrier && msg.sender != sh.customer) revert NotParty();
        cid = ++settlementCount;
        settlements[cid] = Settlement({
            shipment: sid,
            amountEur: amountEur,
            waiveDelay: waiveDelay,
            carrierSigned: isCarrier,
            customerSigned: !isCarrier,
            executed: false,
            ref: ref,
            evidence: evidence
        });
        emit SettlementProposed(cid, sid, amountEur, waiveDelay, ref, evidence);
        emit SettlementSigned(cid, msg.sender);
    }

    function sign(uint32 cid) external {
        Settlement storage c = settlements[cid];
        if (c.shipment == 0 || c.executed) revert BadState();
        Shipment storage sh = shipments[c.shipment];
        if (msg.sender == sh.carrier) {
            if (c.carrierSigned) revert BadState();
            c.carrierSigned = true;
        } else if (msg.sender == sh.customer) {
            if (c.customerSigned) revert BadState();
            c.customerSigned = true;
        } else {
            revert NotParty();
        }
        emit SettlementSigned(cid, msg.sender);
        if (c.carrierSigned && c.customerSigned) _execute(cid, c, sh);
    }

    function fundPool(uint32 amountEur) external {
        _pull(msg.sender, amountEur);
        poolEur[msg.sender] += amountEur;
        emit PoolFunded(msg.sender, amountEur);
    }

    // ------------------------------------------------------------------ views

    /// @notice Compensation accrued in the wagon's open excursion, not yet paid.
    function accruedEur(uint32 id) external view returns (uint256) {
        Wagon storage w = wagons[id];
        WagonState memory s = states[id];
        if (s.excursionStart == 0) return 0;
        uint256 due = _due(w, s, uint40(block.timestamp));
        uint256 room = w.capEur - s.paidEur;
        return due > room ? room : due;
    }

    // ------------------------------------------------------------------ internals

    function _due(Wagon storage w, WagonState memory s, uint40 nowTs) private view returns (uint256) {
        uint256 duration = nowTs - s.excursionStart;
        return duration > w.graceSec ? (duration - w.graceSec) * w.rateEur : 0;
    }

    function _settle(uint32 id, Wagon storage w, WagonState memory s, uint40 nowTs) private {
        uint256 due = _due(w, s, nowTs);
        uint256 room = w.capEur - s.paidEur;
        bool capped = due >= room;
        if (capped) due = room;
        uint32 secondsOut = uint32(nowTs - s.excursionStart);
        s.excursionStart = 0;
        if (capped) s.capped = true;
        uint32 paid;
        if (due > 0) {
            paid = _payFromBond(w.shipment, uint32(due), id, PAY_EXCURSION);
            s.paidEur += paid;
        }
        emit ExcursionEnded(id, secondsOut, paid, capped);
    }

    function _locomotive(uint32 sid, uint8 flags, uint40 nowTs) private {
        Shipment storage sh = shipments[sid];
        if (flags & FLAG_ARRIVED != 0 && sh.arrivedAt == 0) {
            sh.arrivedAt = nowTs;
            bool late = nowTs > sh.deadline;
            emit Arrived(sid, late);
            if (late && sh.delayState == DELAY_NONE) _accrueDelay(sid, sh);
        }
        bool stopped = flags & FLAG_STOPPED != 0 && sh.arrivedAt == 0;
        if (stopped != (sh.stoppedAt != 0)) {
            sh.stoppedAt = stopped ? nowTs : 0;
            emit Standstill(sid, stopped);
        }
    }

    function _accrueDelay(uint32 sid, Shipment storage sh) private {
        sh.delayState = DELAY_ACCRUED;
        sh.delayAt = uint40(block.timestamp);
        emit DelayAccrued(sid, sh.delayPenaltyEur, uint40(block.timestamp + sh.challengeWindow));
    }

    function _execute(uint32 cid, Settlement storage c, Shipment storage sh) private {
        c.executed = true;
        uint32 amount = c.amountEur;
        if (amount > 0) {
            if (uint256(sh.claimedEur) + amount > sh.liabilityCapEur) revert OverCap();
            if (poolEur[sh.carrier] < amount) revert PoolEmpty();
            poolEur[sh.carrier] -= amount;
            sh.claimedEur += amount;
            _send(sh.customer, amount);
            emit Payout(c.shipment, 0, sh.customer, amount, PAY_SETTLEMENT);
        }
        if (c.waiveDelay && (sh.delayState == DELAY_ACCRUED || sh.delayState == DELAY_DISPUTED)) {
            sh.delayState = DELAY_WAIVED;
            emit DelayResolved(c.shipment, DELAY_WAIVED);
        }
        emit SettlementExecuted(cid);
    }

    function _payFromBond(uint32 sid, uint32 amountEur, uint32 wagon, uint8 reason) private returns (uint32 paid) {
        Shipment storage sh = shipments[sid];
        paid = amountEur > sh.bondEur ? sh.bondEur : amountEur;
        if (paid == 0) return 0;
        sh.bondEur -= paid;
        _send(sh.customer, paid);
        emit Payout(sid, wagon, sh.customer, paid, reason);
    }

    function _pull(address from, uint32 amountEur) private {
        if (!token.transferFrom(from, address(this), uint256(amountEur) * EUR)) revert TransferFailed();
    }

    function _send(address to, uint32 amountEur) private {
        if (!token.transfer(to, uint256(amountEur) * EUR)) revert TransferFailed();
    }
}
