// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice One wagon, one condition, a bond in MON. Compensation follows the case terms: a reading past the
/// limit starts an excursion (timed by the block clock); after the grace period every reading pays
/// `seconds out of limits × rate` to the customer in the same transaction, up to the cap. A reading back
/// inside the limits ends the excursion. Delivery refunds the rest of the bond to the carrier.
/// Deployed as EIP-1167 clones by SensorPayoutFactory: each copy has its own storage, so the sensors'
/// transactions do not conflict and Monad executes them in parallel.
contract SensorPayout {
    uint8 public constant ABOVE = 1; // overheat, shock
    uint8 public constant BELOW = 2; // pressure loss
    uint8 public constant ACTIVE = 1;
    uint8 public constant DELIVERED = 2;

    // slot 0: what every reading needs
    uint8 public state;
    uint8 public trigger;
    int32 public limit; // tenths: °C ×10, bar ×10, g ×10
    uint32 public graceS;
    uint40 public breachStart; // 0 = no excursion
    uint40 public paidUntil;
    // cold slots
    address public oracle;
    address payable public carrier;
    address payable public customer;
    uint256 public rate; // wei per second out of limits, after the grace period
    uint256 public cap; // = bond
    uint256 public paid;
    bytes32 public caseId;

    event Reading(bytes32 indexed caseId, int32 value);
    event ExcursionStarted(bytes32 indexed caseId, int32 value, uint40 at);
    event Compensation(bytes32 indexed caseId, address indexed customer, uint256 amount, uint40 secondsPaid, uint256 totalPaid);
    event ExcursionEnded(bytes32 indexed caseId, int32 value, uint40 at);
    event Delivered(bytes32 indexed caseId, address indexed carrier, uint256 refund);

    error AlreadyInitialized();
    error NotOracle();
    error NotActive();
    error WrongBond();
    error PaymentFailed();

    function init(
        bytes32 caseId_,
        uint8 trigger_,
        int32 limit_,
        uint32 graceS_,
        uint256 rate_,
        address oracle_,
        address payable carrier_,
        address payable customer_
    ) external payable {
        if (state != 0) revert AlreadyInitialized();
        if (msg.value == 0) revert WrongBond();
        state = ACTIVE;
        trigger = trigger_;
        limit = limit_;
        graceS = graceS_;
        oracle = oracle_;
        carrier = carrier_;
        customer = customer_;
        rate = rate_;
        cap = msg.value;
        caseId = caseId_;
    }

    function report(int32 value) external {
        if (msg.sender != oracle) revert NotOracle();
        if (state != ACTIVE) revert NotActive();
        bytes32 id = caseId;
        emit Reading(id, value);
        uint40 nowTs = uint40(block.timestamp);
        bool out = trigger == ABOVE ? value > limit : value < limit;
        if (out) {
            if (breachStart == 0) {
                breachStart = nowTs;
                emit ExcursionStarted(id, value, nowTs);
            }
            _accrue(nowTs);
        } else if (breachStart != 0) {
            _accrue(nowTs);
            breachStart = 0;
            emit ExcursionEnded(id, value, nowTs);
        }
    }

    /// @notice Arrival: settle a running excursion, then refund the rest of the bond to the carrier.
    function deliver() external {
        if (msg.sender != oracle) revert NotOracle();
        if (state != ACTIVE) revert NotActive();
        if (breachStart != 0) _accrue(uint40(block.timestamp));
        state = DELIVERED;
        uint256 refund = address(this).balance;
        (bool ok,) = carrier.call{ value: refund }("");
        if (!ok) revert PaymentFailed();
        emit Delivered(caseId, carrier, refund);
    }

    /// @notice What the customer would receive if a reading were sent now (for dashboards).
    function due() external view returns (uint256) {
        if (breachStart == 0) return 0;
        (uint256 amt,) = _owed(uint40(block.timestamp));
        return amt;
    }

    function _owed(uint40 nowTs) private view returns (uint256 amt, uint40 secs) {
        uint40 start = breachStart + uint40(graceS);
        if (paidUntil > start) start = paidUntil;
        if (nowTs <= start) return (0, 0);
        secs = nowTs - start;
        amt = uint256(secs) * rate;
        uint256 left = cap - paid;
        if (amt > left) amt = left;
    }

    function _accrue(uint40 nowTs) private {
        (uint256 amt, uint40 secs) = _owed(nowTs);
        if (secs == 0) return;
        paidUntil = nowTs;
        if (amt == 0) return;
        paid += amt;
        (bool ok,) = customer.call{ value: amt }("");
        if (!ok) revert PaymentFailed();
        emit Compensation(caseId, customer, amt, secs, paid);
    }
}

/// @notice Creates funded copies of SensorPayout per case condition in one transaction (bonds sent as value).
contract SensorPayoutFactory {
    struct Template {
        bytes32 caseId;
        uint8 trigger;
        int32 limit;
        uint32 graceS;
        uint256 rate;
        uint256 cap;
    }

    struct Parties {
        address oracle;
        address payable carrier;
        address payable customer;
    }

    address public immutable implementation;
    address public immutable owner;
    address[] public copies;

    event Created(address indexed copy, bytes32 indexed caseId, uint8 trigger, int32 limit, uint32 graceS, uint256 rate, uint256 cap, uint16 index);

    constructor() {
        implementation = address(new SensorPayout());
        owner = msg.sender;
    }

    function createMany(Template[] calldata ts, uint16 n, Parties calldata p) external payable {
        require(msg.sender == owner, "owner only");
        uint256 total;
        for (uint256 i; i < ts.length; ++i) {
            total += ts[i].cap * n;
            for (uint16 c; c < n; ++c) {
                _createOne(ts[i], p, c);
            }
        }
        require(msg.value == total, "value must equal the sum of the caps");
    }

    function _createOne(Template calldata t, Parties calldata p, uint16 c) private {
        address inst = _clone(implementation);
        SensorPayout(inst).init{ value: t.cap }(t.caseId, t.trigger, t.limit, t.graceS, t.rate, p.oracle, p.carrier, p.customer);
        copies.push(inst);
        emit Created(inst, t.caseId, t.trigger, t.limit, t.graceS, t.rate, t.cap, c);
    }

    function count() external view returns (uint256) {
        return copies.length;
    }

    function all() external view returns (address[] memory) {
        return copies;
    }

    /// @dev EIP-1167 minimal proxy.
    function _clone(address impl) private returns (address inst) {
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly ("memory-safe") {
            inst := create(0, add(code, 0x20), mload(code))
        }
        require(inst != address(0), "clone failed");
    }
}
