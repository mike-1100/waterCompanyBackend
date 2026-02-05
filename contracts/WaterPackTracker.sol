// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title WaterPackTracker
 * @dev Tracks water batch lifecycle using Merkle trees for serial verification
 */
contract WaterPackTracker {

    // Batch status - ADDED SOLD STATUS
    enum BatchStatus { CREATED, INSPECTING, APPROVED, PARTIALLY_REJECTED, REJECTED, DISTRIBUTED, SOLD }

    // Batch struct
    struct Batch {
        string batch_no;
        bytes32 merkleRoot;
        uint256 totalUnits;
        uint256 rejectedUnits; // optional if you track partial rejections off-chain
        BatchStatus status;
        address createdBy;
        uint256 createdAt;
        bool exists;
    }

    // Mappings
    mapping(string => Batch) public batches;
    string[] public allBatchNumbers;

    // Roles
    mapping(address => bool) public admins;
    mapping(address => bool) public inspectors;
    address public owner;

    // Events
    event BatchCreated(string batch_no, bytes32 merkleRoot, uint256 totalUnits);
    event BatchApproved(string batch_no);
    event BatchRejected(string batch_no, string reason);
    event BatchDistributed(string batch_no);
    event BatchSold(string batch_no); // NEW EVENT
    event AdminAdded(address admin);
    event InspectorAdded(address inspector);

    // Modifiers
    modifier onlyOwner() { require(msg.sender == owner, "Only owner"); _; }
    modifier onlyAdmin() { require(admins[msg.sender] || msg.sender == owner, "Only admin"); _; }
    modifier onlyInspectorOrAdmin() { require(inspectors[msg.sender] || admins[msg.sender] || msg.sender == owner, "Only inspector/admin"); _; }

    constructor() {
        owner = msg.sender;
        admins[msg.sender] = true;
    }

    // ---------------- Roles ----------------
    function addAdmin(address _admin) external onlyOwner {
        admins[_admin] = true;
        emit AdminAdded(_admin);
    }

    function addInspector(address _inspector) external onlyAdmin {
        inspectors[_inspector] = true;
        emit InspectorAdded(_inspector);
    }

    // ---------------- Batches ----------------
    function createBatch(string memory batch_no, bytes32 merkleRoot, uint256 totalUnits) external onlyAdmin {
      require(!batches[batch_no].exists, "Batch exists");

      batches[batch_no] = Batch({
        batch_no: batch_no,
        merkleRoot: merkleRoot,
        totalUnits: totalUnits,
        rejectedUnits: 0,
        status: BatchStatus.CREATED,
        createdBy: msg.sender,
        createdAt: block.timestamp,
        exists: true
      });

      allBatchNumbers.push(batch_no);
      emit BatchCreated(batch_no, merkleRoot, totalUnits);
    }


    function approveBatch(string memory batch_no) external onlyAdmin {
        Batch storage batch = batches[batch_no];
        require(batch.exists, "Batch not found");
        require(batch.status != BatchStatus.REJECTED, "Batch rejected");
        batch.status = BatchStatus.APPROVED;
        emit BatchApproved(batch_no);
    }

    function rejectBatch(string memory batch_no, string memory reason) external onlyAdmin {
        require(bytes(reason).length > 0, "Reason required");
        Batch storage batch = batches[batch_no];
        require(batch.exists, "Batch not found");
        batch.status = BatchStatus.REJECTED;
        batch.rejectedUnits = batch.totalUnits; // optional, mostly tracked off-chain
        emit BatchRejected(batch_no, reason);
    }

    function distributeBatch(string memory batch_no) external onlyAdmin {
        Batch storage batch = batches[batch_no];
        require(batch.exists, "Batch not found");
        require(batch.status == BatchStatus.APPROVED || batch.status == BatchStatus.PARTIALLY_REJECTED, "Batch not approved");
        batch.status = BatchStatus.DISTRIBUTED;
        emit BatchDistributed(batch_no);
    }

    // NEW FUNCTION - Sell Batch
    function sellBatch(string memory batch_no) external onlyAdmin {
        Batch storage batch = batches[batch_no];
        require(batch.exists, "Batch not found");
        require(batch.status == BatchStatus.DISTRIBUTED, "Batch must be distributed before selling");
        batch.status = BatchStatus.SOLD;
        emit BatchSold(batch_no);
    }

    // ---------------- Merkle verification ----------------
    function verifyWaterPack(string memory serialCode, string memory batch_no, bytes32[] memory proof) external view returns (bool) {
        Batch memory batch = batches[batch_no];
        require(batch.exists, "Batch not found");
        bytes32 leaf = keccak256(abi.encodePacked(serialCode));
        return MerkleProof.verify(proof, batch.merkleRoot, leaf);
    }

    // ---------------- Helpers ----------------
    function getAllBatches() external view returns (string[] memory) {
        return allBatchNumbers;
    }

    function getBatchDetails(string memory batch_no) external view returns (Batch memory) {
        require(batches[batch_no].exists, "Batch not found");
        return batches[batch_no];
    }

    // NEW HELPER - Get total water packs across all batches
    function getTotalWaterPacks() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < allBatchNumbers.length; i++) {
            total += batches[allBatchNumbers[i]].totalUnits;
        }
        return total;
    }
}