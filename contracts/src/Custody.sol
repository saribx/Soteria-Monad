// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Who Had It? — custody, evidence and settlement for goods in motion
/// @notice Every party and every wagon sensor is a P-256 key (passkey / secure-element curve).
///         Signatures are checked on-chain via the P256VERIFY precompile at 0x0100 (EIP-7951).
///         Signed message = abi.encodePacked(chainId, address(this), op, ...fields). The contract
///         hashes it once with sha256; the browser signs the same raw bytes with
///         crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, bytes).
contract Custody {
    // ---- roles & ops -------------------------------------------------------------------------
    uint8 public constant ROLE_SHIPPER = 1;
    uint8 public constant ROLE_CARRIER = 2;
    uint8 public constant ROLE_RECEIVER = 3;
    uint8 public constant ROLE_WAGON = 4;

    uint8 public constant OP_CREATE = 1;
    uint8 public constant OP_BATCH = 2;
    uint8 public constant OP_HANDOVER = 3;
    uint8 public constant OP_ALARM = 4;
    uint8 public constant OP_KEYS = 5;

    uint8 public constant KIND_SHOCK = 1;

    address internal constant P256_VERIFY = address(0x100);

    // ---- types -------------------------------------------------------------------------------
    struct Sig {
        bytes32 r;
        bytes32 s;
    }

    struct Party {
        bytes32 x;
        bytes32 y;
        uint8 role;
    }

    /// @dev Terms the shipper signs when creating a shipment. Amounts are tEUR cents.
    struct Terms {
        bytes32 shipper;
        bytes32 carrier;
        bytes32 receiver;
        uint64 penalty; // charged per shock alarm
        uint64 cap; // total charges per shipment
        uint16 shockLimitCg; // shock threshold in centi-g (520 = 5.20 g)
        uint64 expiry; // unix seconds; signature invalid after this
    }

    struct Shipment {
        bytes32 shipper;
        bytes32 receiver;
        bytes32 holder;
        uint32 epoch;
        uint16 shockLimitCg;
        uint64 penalty;
        uint64 cap;
        uint64 paid;
    }

    // ---- state -------------------------------------------------------------------------------
    address public owner;
    mapping(bytes32 => Party) public parties;
    mapping(bytes32 => uint256) public balanceOf; // tEUR cents, by party key
    mapping(uint256 => Shipment) public shipments;
    mapping(uint256 => bytes32[]) internal _wagons;
    mapping(uint256 => mapping(uint8 => uint64)) public lastSeq;
    mapping(uint256 => mapping(uint64 => bool)) public alarmUsed;
    /// @notice Running commitment over every batch: head = keccak256(head, root, sha256(ciphertext)).
    mapping(uint256 => bytes32) public head;

    // ---- events ------------------------------------------------------------------------------
    event PartyRegistered(bytes32 indexed key, uint8 role, string name, bytes32 x, bytes32 y);
    event EncKeyRegistered(bytes32 indexed key, bytes ecdhPub);
    event Funded(bytes32 indexed key, uint256 amount, uint256 balance);
    event ShipmentCreated(
        uint256 indexed id,
        bytes32 shipper,
        bytes32 carrier,
        bytes32 receiver,
        uint64 penalty,
        uint64 cap,
        uint16 shockLimitCg,
        bytes32[] wagonKeys
    );
    event Handover(uint256 indexed id, uint32 epoch, bytes32 from, bytes32 to, bytes32 reservation);
    event Batch(
        uint256 indexed id, uint8 wagon, uint32 epoch, uint64 seq, bytes32 root, uint8 status, bytes ciphertext
    );
    event Alarm(
        uint256 indexed id, uint8 wagon, uint32 epoch, uint8 kind, uint16 valueCg, bytes32 holder, uint64 penalty
    );
    event KeyWrapped(uint256 indexed id, uint32 epoch, bytes32 indexed partyKey, bytes wrapped);

    // ---- errors ------------------------------------------------------------------------------
    error NotOwner();
    error NotVerified();
    error WrongRole();
    error BadSignature();
    error StaleEpoch();
    error Replay();
    error Expired();
    error UnknownShipment();
    error ShipmentExists();
    error UnknownWagon();
    error BadStatus();
    error BelowLimit();
    error UnknownKind();
    error Delivered();
    error LengthMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ---- admin (demo allowlisting, not accreditation) ------------------------------------------
    function registerParty(bytes32 x, bytes32 y, uint8 role, string calldata name)
        external
        onlyOwner
        returns (bytes32 key)
    {
        if (role < ROLE_SHIPPER || role > ROLE_WAGON) revert WrongRole();
        key = keyOf(x, y);
        parties[key] = Party(x, y, role);
        emit PartyRegistered(key, role, name, x, y);
    }

    /// @notice Publishes a party's ECDH P-256 public key (for wrapping per-epoch data keys).
    function registerEncKey(bytes32 partyKey, bytes calldata ecdhPub) external onlyOwner {
        if (parties[partyKey].role == 0) revert NotVerified();
        emit EncKeyRegistered(partyKey, ecdhPub);
    }

    /// @notice Demo tEUR. Balances live inside this contract; no ERC-20, no approvals.
    function faucet(bytes32 partyKey, uint256 amount) external onlyOwner {
        if (parties[partyKey].role == 0) revert NotVerified();
        uint256 bal = balanceOf[partyKey] + amount;
        balanceOf[partyKey] = bal;
        emit Funded(partyKey, amount, bal);
    }

    // ---- custody protocol --------------------------------------------------------------------
    /// @notice Shipper signs the terms; custody starts with the carrier at epoch 1.
    function createShipment(uint256 id, Terms calldata t, bytes32[] calldata wagonKeys, Sig calldata sig) external {
        if (shipments[id].epoch != 0) revert ShipmentExists();
        if (block.timestamp > t.expiry) revert Expired();
        _requireRole(t.shipper, ROLE_SHIPPER);
        _requireRole(t.carrier, ROLE_CARRIER);
        _requireRole(t.receiver, ROLE_RECEIVER);
        for (uint256 i; i < wagonKeys.length; ++i) {
            _requireRole(wagonKeys[i], ROLE_WAGON);
        }

        bytes memory message = abi.encodePacked(
            block.chainid,
            address(this),
            OP_CREATE,
            id,
            t.shipper,
            t.carrier,
            t.receiver,
            t.penalty,
            t.cap,
            t.shockLimitCg,
            keccak256(abi.encodePacked(wagonKeys)),
            t.expiry
        );
        _verify(t.shipper, message, sig);

        shipments[id] = Shipment({
            shipper: t.shipper,
            receiver: t.receiver,
            holder: t.carrier,
            epoch: 1,
            shockLimitCg: t.shockLimitCg,
            penalty: t.penalty,
            cap: t.cap,
            paid: 0
        });
        _wagons[id] = wagonKeys;

        emit ShipmentCreated(id, t.shipper, t.carrier, t.receiver, t.penalty, t.cap, t.shockLimitCg, wagonKeys);
        emit Handover(id, 1, t.shipper, t.carrier, bytes32(0));
    }

    /// @notice Both sides sign the same message. Epoch increments atomically.
    function handover(
        uint256 id,
        uint32 epoch,
        bytes32 to,
        bytes32 reservation,
        uint64 expiry,
        Sig calldata giver,
        Sig calldata receiver
    ) external {
        Shipment storage s = _shipment(id);
        if (epoch != s.epoch) revert StaleEpoch();
        if (block.timestamp > expiry) revert Expired();
        bytes32 from = s.holder;
        if (from == s.receiver) revert Delivered();
        uint8 role = parties[to].role;
        if (role == 0) revert NotVerified();
        if (role != ROLE_CARRIER && role != ROLE_RECEIVER) revert WrongRole();

        bytes memory message =
            abi.encodePacked(block.chainid, address(this), OP_HANDOVER, id, epoch, from, to, reservation, expiry);
        _verify(from, message, giver);
        _verify(to, message, receiver);

        uint32 next = epoch + 1;
        s.holder = to;
        s.epoch = next;
        emit Handover(id, next, from, to, reservation);
    }

    /// @notice A wagon sensor seals a batch of readings. The signature covers sha256(ciphertext).
    function commitBatch(
        uint256 id,
        uint8 wagon,
        uint32 epoch,
        uint64 seq,
        bytes32 root,
        uint8 status,
        bytes calldata ciphertext,
        Sig calldata sig
    ) external {
        Shipment storage s = _shipment(id);
        bytes32 wagonKey = _wagonKey(id, wagon);
        if (epoch != s.epoch) revert StaleEpoch();
        if (seq <= lastSeq[id][wagon]) revert Replay();
        if (status > 2) revert BadStatus();

        bytes32 ctHash = sha256(ciphertext);
        bytes memory message =
            abi.encodePacked(block.chainid, address(this), OP_BATCH, id, wagon, epoch, seq, root, status, ctHash);
        _verify(wagonKey, message, sig);

        lastSeq[id][wagon] = seq;
        head[id] = keccak256(abi.encodePacked(head[id], root, ctHash));
        emit Batch(id, wagon, epoch, seq, root, status, ciphertext);
    }

    /// @notice A signed breach. Charged to whoever holds custody in this epoch, paid to the shipper.
    function alarm(
        uint256 id,
        uint32 epoch,
        uint8 wagon,
        uint64 alarmId,
        uint8 kind,
        uint16 valueCg,
        Sig calldata sig
    ) external {
        Shipment storage s = _shipment(id);
        bytes32 wagonKey = _wagonKey(id, wagon);
        if (epoch != s.epoch) revert StaleEpoch();
        if (alarmUsed[id][alarmId]) revert Replay();
        if (kind != KIND_SHOCK) revert UnknownKind();
        if (valueCg <= s.shockLimitCg) revert BelowLimit();
        bytes32 holder = s.holder;
        if (holder == s.receiver) revert Delivered();

        bytes memory message =
            abi.encodePacked(block.chainid, address(this), OP_ALARM, id, epoch, wagon, alarmId, kind, valueCg);
        _verify(wagonKey, message, sig);

        alarmUsed[id][alarmId] = true;
        uint64 p = s.penalty;
        uint64 room = s.cap - s.paid;
        if (p > room) p = room;
        uint256 bal = balanceOf[holder];
        if (p > bal) p = uint64(bal);
        if (p > 0) {
            balanceOf[holder] = bal - p;
            balanceOf[s.shipper] += p;
            s.paid += p;
        }
        emit Alarm(id, wagon, epoch, kind, valueCg, holder, p);
    }

    /// @notice Publishes the per-epoch data key, wrapped for each reader. Signed by the shipper or the holder.
    function postKeys(
        uint256 id,
        uint32 epoch,
        bytes32 signer,
        bytes32[] calldata partyKeys,
        bytes[] calldata wrapped,
        Sig calldata sig
    ) external {
        Shipment storage s = _shipment(id);
        if (epoch != s.epoch) revert StaleEpoch();
        if (signer != s.shipper && signer != s.holder) revert WrongRole();
        if (partyKeys.length != wrapped.length) revert LengthMismatch();

        bytes memory message = abi.encodePacked(
            block.chainid, address(this), OP_KEYS, id, epoch, signer, keccak256(abi.encode(partyKeys, wrapped))
        );
        _verify(signer, message, sig);

        for (uint256 i; i < partyKeys.length; ++i) {
            emit KeyWrapped(id, epoch, partyKeys[i], wrapped[i]);
        }
    }

    // ---- views -------------------------------------------------------------------------------
    function keyOf(bytes32 x, bytes32 y) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(x, y));
    }

    function wagonsOf(uint256 id) external view returns (bytes32[] memory) {
        return _wagons[id];
    }

    /// @notice Debug helper: does (x, y) sign `message` with (r, s)? Same path as every write.
    function checkSig(bytes calldata message, bytes32 x, bytes32 y, bytes32 r, bytes32 s)
        external
        view
        returns (bool)
    {
        return _p256(sha256(message), r, s, x, y);
    }

    // ---- internals ---------------------------------------------------------------------------
    function _shipment(uint256 id) internal view returns (Shipment storage s) {
        s = shipments[id];
        if (s.epoch == 0) revert UnknownShipment();
    }

    function _wagonKey(uint256 id, uint8 wagon) internal view returns (bytes32) {
        bytes32[] storage w = _wagons[id];
        if (wagon >= w.length) revert UnknownWagon();
        return w[wagon];
    }

    function _requireRole(bytes32 key, uint8 role) internal view {
        uint8 r = parties[key].role;
        if (r == 0) revert NotVerified();
        if (r != role) revert WrongRole();
    }

    function _verify(bytes32 key, bytes memory message, Sig calldata sig) internal view {
        Party storage p = parties[key];
        if (p.role == 0) revert NotVerified();
        if (!_p256(sha256(message), sig.r, sig.s, p.x, p.y)) revert BadSignature();
    }

    function _p256(bytes32 digest, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool) {
        (bool ok, bytes memory ret) = P256_VERIFY.staticcall(abi.encode(digest, r, s, x, y));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }
}
