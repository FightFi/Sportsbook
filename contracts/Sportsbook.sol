// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @title Sportsbook - Prediction Market Contract (MVP)
/// @notice Implements a simple prediction system with public outcomes
/// @dev Contract is upgradeable via UUPS pattern with access control and pausable functionality
/// @dev Uses ERC1155 (FP1155) for Season FP tokens
contract Sportsbook is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable, 
    AccessControlEnumerableUpgradeable, 
    PausableUpgradeable,
    ERC1155HolderUpgradeable
{
    // Error codes
    // Sportsbook: Invalid user                                    - SB-1
    // Sportsbook: Invalid FP1155 contract address                 - SB-2
    // Sportsbook: Market already resolved                          - SB-9
    // Sportsbook: Invalid bet amount (below min or above max)      - SB-10
    // Sportsbook: Invalid outcome                                  - SB-11
    // Sportsbook: Invalid card or market                           - SB-12
    // Sportsbook: Insufficient FP balance                         - SB-13
    // Sportsbook: Invalid time parameter                           - SB-15
    // Sportsbook: Invalid min/max bet amounts                     - SB-16
    // Sportsbook: Invalid prize pool amount                        - SB-17
    // Sportsbook: Must have at least one winner                   - SB-18
    // Sportsbook: Claim window expired                             - SB-19
    // Sportsbook: Claim window not open                           - SB-20
    // Sportsbook: User already placed predictions in this season  - SB-23

    // Role definitions
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // State variables
    address public fpContract; // FP1155 contract address
    uint256 public constant CLAIM_WINDOW = 72 hours; // Claim window duration

    // Season and fight configuration
    mapping(uint256 => Season) public seasons; // seasonId => Season struct
    mapping(uint256 => mapping(uint256 => FightConfig)) public fights; // seasonId => fightId => FightConfig
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Pool))) public pools; // seasonId => fightId => outcome => Pool
    mapping(uint256 => mapping(uint256 => FightState)) public fightStates; // seasonId => fightId => FightState

    // Position tracking
    mapping(address => mapping(uint256 => mapping(uint256 => Position))) public userPositions; // user => seasonId => fightId => Position
    

    // Structs
    struct Season {
        uint256 cutOffTime; // Season cut-off time (0 = season doesn't exist)
        uint256 seasonTokenId; // ERC1155 token ID for this season
        uint256 numFights; // Number of fights in this season
        bool resolved; // Whether season is resolved (all fights resolved together)
        uint256 settlementTime; // Settlement timestamp (all fights resolved together)
    }

    struct FightConfig {
        uint256 minBet; // Minimum bet amount in FP
        uint256 maxBet; // Maximum bet amount in FP
        uint256 numOutcomes; // Number of possible outcomes (0 = fight doesn't exist)
    }

    struct FightState {
        uint256 prizePool; // Fight-level prize pool amount in FP
        uint256 fighterAStaked; // Total staked for fighter A
        uint256 fighterBStaked; // Total staked for fighter B
        uint256 fpPerShare; // FP per share (0 if not resolved)
        uint256 winningOutcome; // Winning outcome (0 if not resolved)
    }

    struct Pool {
        uint256 totalStaked; // Total FP staked in this pool
    }


    struct Position {
        uint256 outcome; // Outcome selected by user
        uint256 stakeAmount; // Amount of FP staked
        bool claimed; // Whether winnings have been claimed
    }

    // Events
    event SeasonCreated(
        uint256 indexed seasonId,
        uint256 cutOffTime,
        uint256 seasonTokenId,
        uint256 numFights
    );

    event PredictionLocked(
        address indexed user,
        uint256 indexed seasonId,
        uint256 indexed fightId,
        uint256 outcome,
        uint256 stakeAmount
    );

    event FightResolved(
        uint256 indexed seasonId,
        uint256 indexed fightId,
        uint8 winningOutcome,
        uint256 fpPerShare
    );

    event PrizePoolSeeded(
        uint256 indexed seasonId,
        uint256 indexed fightId,
        uint256 amount
    );

    event Claimed(
        address indexed user,
        uint256 indexed seasonId,
        uint256 indexed fightId,
        uint256 amount
    );

    event FPContractUpdated(
        address indexed oldContract,
        address indexed newContract
    );

    event RemainingBalanceRecovered(
        address indexed recipient,
        uint256 indexed seasonId,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the Sportsbook contract
    /// @param _fpContract Address of the FP1155 contract
    /// @param _admin Address to grant ADMIN_ROLE
    function initialize(
        address _fpContract,
        address _admin
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __AccessControlEnumerable_init();
        __Pausable_init();
        __ERC1155Holder_init();

        require(_fpContract != address(0), "SB-2");

        fpContract = _fpContract;

        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice Create a season with all its fights in one transaction
    /// @param seasonId The season ID
    /// @param cutOffTime Season cut-off time (timestamp)
    /// @param seasonTokenId The ERC1155 token ID for this season
    /// @param fightConfigs Array of fight configurations (one per fight, fightIds are 0, 1, 2, ... n-1)
    /// @param fightPrizePoolAmounts Array of fight-level prize pool amounts (one per fight, can be 0)
    function createSeasonWithFights(
        uint256 seasonId,
        uint256 cutOffTime,
        uint256 seasonTokenId,
        FightConfig[] calldata fightConfigs,
        uint256[] calldata fightPrizePoolAmounts
    ) external onlyRole(ADMIN_ROLE) {
        // Validate season doesn't exist (cutOffTime == 0 means season doesn't exist)
        require(seasons[seasonId].cutOffTime == 0, "SB-12");
        require(cutOffTime > block.timestamp, "SB-15");
        require(seasonTokenId > 0, "SB-12");
        
        // Validate arrays have same length
        require(fightConfigs.length == fightPrizePoolAmounts.length, "SB-12");
        require(fightConfigs.length > 0, "SB-12");

        // Calculate total fight prize pool amount to transfer
        uint256 totalFightPrizePool = 0;
        for (uint256 i = 0; i < fightPrizePoolAmounts.length; i++) {
            totalFightPrizePool += fightPrizePoolAmounts[i];
        }

        // Transfer all fight prize pool tokens at once (if any)
        if (totalFightPrizePool > 0) {
            IERC1155(fpContract).safeTransferFrom(msg.sender, address(this), seasonTokenId, totalFightPrizePool, "");
        }

        // Create season
        seasons[seasonId] = Season({
            cutOffTime: cutOffTime,
            seasonTokenId: seasonTokenId,
            numFights: fightConfigs.length,
            resolved: false,
            settlementTime: 0
        });
        
        emit SeasonCreated(seasonId, cutOffTime, seasonTokenId, fightConfigs.length);

        // Create all fights and set prize pools
        // Fight IDs are sequential starting from 0 (0, 1, 2, ... n-1)
        for (uint256 i = 0; i < fightConfigs.length; i++) {
            uint256 fightId = i;
            FightConfig calldata cfg = fightConfigs[i];
            uint256 prizePoolAmount = fightPrizePoolAmounts[i];
            
            require(fights[seasonId][fightId].numOutcomes == 0, "SB-12"); // Fight must not exist
            require(cfg.minBet > 0 && cfg.maxBet >= cfg.minBet, "SB-16");
            require(cfg.numOutcomes >= 2, "SB-11");

            fights[seasonId][fightId] = cfg;

            // Initialize fight state
            fightStates[seasonId][fightId] = FightState({
                prizePool: prizePoolAmount,
                fighterAStaked: 0,
                fighterBStaked: 0,
                fpPerShare: 0,
                winningOutcome: 0
            });
        }
    }

    /// @notice Lock predictions for multiple fights in a season in batch
    /// @dev User submits outcomes for specific fights in a season and stakes FP
    /// @dev User can only place predictions once per season (per fight)
    /// @dev Predictions can only be made before the season's cutOffTime
    /// @param seasonId The season ID
    /// @param fightIds Array of fight IDs to bet on (must be valid and unique)
    /// @param outcomes Array of outcomes selected by user (one per fightId)
    /// @param stakes Array of FP stake amounts (one per fightId)
    function lockPredictionsBatch(
        uint256 seasonId,
        uint256[] calldata fightIds,
        uint256[] calldata outcomes,
        uint256[] calldata stakes
    ) external whenNotPaused nonReentrant {
        // Validate season exists (cutOffTime > 0 means season exists)
        require(seasons[seasonId].cutOffTime > 0, "SB-12");
        
        // Validate season is still open for predictions (before cutOffTime)
        require(block.timestamp <= seasons[seasonId].cutOffTime, "SB-15");
        
        // Season must not be resolved
        require(!seasons[seasonId].resolved, "SB-9");
        
        // Get seasonTokenId from season struct
        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");
        
        // Get number of fights for this season
        uint256 numFights = seasons[seasonId].numFights;
        require(numFights > 0, "SB-12");
        
        // Validate arrays have same length
        require(fightIds.length == outcomes.length, "SB-12");
        require(fightIds.length == stakes.length, "SB-12");
        require(fightIds.length > 0, "SB-12");

        // Validate fightIds are unique and within valid range
        for (uint256 i = 0; i < fightIds.length; i++) {
            uint256 fightId = fightIds[i];
            
            // Validate fightId is within valid range
            require(fightId < numFights, "SB-12");
            
            // Validate fight exists (numOutcomes > 0 means fight exists)
            require(fights[seasonId][fightId].numOutcomes > 0, "SB-12");
            
            // Validate user doesn't already have a position in this fight
            require(userPositions[msg.sender][seasonId][fightId].stakeAmount == 0, "SB-23");
            
            // Check for duplicates (fightIds must be unique)
            for (uint256 j = i + 1; j < fightIds.length; j++) {
                require(fightIds[i] != fightIds[j], "SB-12");
            }
        }

        // Calculate total stake amount
        uint256 totalStake = 0;
        for (uint256 i = 0; i < stakes.length; i++) {
            totalStake += stakes[i];
        }

        // Require at least one bet (totalStake > 0)
        require(totalStake > 0, "SB-10");

        // Check FP balance
        require(IERC1155(fpContract).balanceOf(msg.sender, seasonTokenId) >= totalStake, "SB-13");

        // Transfer total FP tokens from user to contract
        IERC1155(fpContract).safeTransferFrom(msg.sender, address(this), seasonTokenId, totalStake, "");

        // Create positions for each specified fight
        for (uint256 i = 0; i < fightIds.length; i++) {
            uint256 fightId = fightIds[i];
            uint256 outcome = outcomes[i];
            uint256 fpStake = stakes[i];
            
            FightConfig storage config = fights[seasonId][fightId];
            require(outcome < config.numOutcomes, "SB-11"); // Valid outcome implies fight exists
            require(fpStake >= config.minBet && fpStake <= config.maxBet, "SB-10");

            // Create position
            userPositions[msg.sender][seasonId][fightId] = Position({
                outcome: outcome,
                stakeAmount: fpStake,
                claimed: false
            });

            // Add stake to outcome pool
            pools[seasonId][fightId][outcome].totalStaked += fpStake;

            // Update fighter staked counters (bit 2: 0 = fighter A, 1 = fighter B)
            uint256 fighter = (outcome >> 2) & 1;
            if (fighter == 0) {
                fightStates[seasonId][fightId].fighterAStaked += fpStake;
            } else {
                fightStates[seasonId][fightId].fighterBStaked += fpStake;
            }

            emit PredictionLocked(msg.sender, seasonId, fightId, outcome, fpStake);
        }
    }

    /// @notice Resolve all fights in a season with their winning outcomes
    /// @dev Can only be called by ADMIN_ROLE
    /// @dev Resolves all fights in a season at once
    /// @param seasonId The season ID    
    /// @param winningOutcomes Array of winning outcomes (one per fight, fightIds are 0, 1, 2, ... n-1)
    function resolveSeason(
        uint256 seasonId,
        uint8[] calldata winningOutcomes
    ) external onlyRole(ADMIN_ROLE) {
        require(seasons[seasonId].cutOffTime > 0, "SB-12");
        require(!seasons[seasonId].resolved, "SB-9");
        
        // Get number of fights for this season
        uint256 numFights = seasons[seasonId].numFights;
        require(numFights > 0, "SB-12");
        require(winningOutcomes.length == numFights, "SB-12");

        uint256 settlementTime = block.timestamp;

        // Resolve each fight (fightIds are sequential: 0, 1, 2, ...)
        for (uint256 i = 0; i < winningOutcomes.length; i++) {
            uint8 winningOutcome = winningOutcomes[i];
            uint256 fightId = i;
               
            FightConfig storage config = fights[seasonId][fightId];
            require(winningOutcome < config.numOutcomes, "SB-11"); // Valid outcome implies fight exists

            // Extract winning fighter index (bit 2) and method (bits 0-1)
            // winningFighterIndex: 0 = fighterA won, 1 = fighterB won
            uint256 winningFighterIndex = (winningOutcome >> 2) & 1;
            uint256 winningMethod = winningOutcome & 0x3;
            
            // Calculate total weighted shares for winning outcomes
            // winningPoolTotalShares: Total weighted shares in winning pool (denominator for FP payout calculation)
            //   - 4 shares per stake if outcome matches exactly (same winner + same method)
            //   - 3 shares per stake if only winner matches (same winner, different method)
            uint256 winningPoolTotalShares = 0;
            
            for (uint256 j = 0; j < config.numOutcomes; j++) {
                Pool storage pool = pools[seasonId][fightId][j];
                uint256 outcomeStaked = pool.totalStaked;
         
                // Check if this outcome is a winning outcome (same winner)
                // winningFighterIndex: 0 = fighterA won, 1 = fighterB won
                uint256 outcomeWinner = (j >> 2) & 1;
                if (outcomeWinner == winningFighterIndex) {
                    // Calculate shares for this outcome:
                    // - 4 shares per stake if method matches exactly (same winner + same method)
                    // - 3 shares per stake if only winner matches (same winner, different method)
                    uint256 outcomeMethod = j & 0x3;
                    uint256 sharesPerStake = (outcomeMethod == winningMethod) ? 4 : 3;
                    winningPoolTotalShares += outcomeStaked * sharesPerStake;
                }
            }
            
            // Calculate total loser stakes directly from fighter counters (more efficient)
            // totalLoserStakes: Sum of stakes from all losing outcomes (different winner)
            FightState storage fightState = fightStates[seasonId][fightId];
            uint256 totalLoserStakes = (winningFighterIndex == 0) 
                ? fightState.fighterBStaked 
                : fightState.fighterAStaked;                

            // Get fight-level prize pool
            uint256 fightLevelPrizePool = fightState.prizePool;

            // totalWinningsPool: Complete prize pool for winners (calculated PER FIGHT, not per season)
            //   - totalLoserStakes: Loser pools (tokens from losing bets in this fight)
            //   - fightLevelPrizePool: Prize pool specific to this fight
            // This pool will be distributed proportionally among all winning positions in THIS FIGHT
            uint256 totalWinningsPool = totalLoserStakes + fightLevelPrizePool;
            
            // Calculate FP per share (truncated down, integer for NFTs)
            // Formula: fpPerShare = totalWinningsPool / winningPoolTotalShares
            // This tells us how much FP to pay per share (truncated down)
            // 
            // Math explanation:
            // - winningPoolTotalShares = Σ(outcomeStaked * sharesPerStake) for all winning outcomes
            // - fpPerShare = totalWinningsPool / winningPoolTotalShares
            // - userWinnings = fpPerShare * userPoints * userStake
            // - The formula DOES account for user investment (userStake) proportionally
            // - Note: Division truncation may leave residual funds (recoverable via recoverRemainingBalance)
            // Require winningPoolTotalShares > 0 to avoid division by zero
            require(winningPoolTotalShares > 0, "SB-18"); // Must have at least one winner
            uint256 fpPerShareValue = totalWinningsPool / winningPoolTotalShares;
            
            // Store resolution data
            fightState.fpPerShare = fpPerShareValue;
            fightState.winningOutcome = uint256(winningOutcome);

            emit FightResolved(seasonId, fightId, winningOutcome, fpPerShareValue);
        }

        // Mark season as resolved (all fights resolved together)
        seasons[seasonId].resolved = true;
        seasons[seasonId].settlementTime = settlementTime;
    }

    /// @notice Claim winnings for all resolved positions in a season
    /// @dev Claim window: 72 hours after resolution opens
    /// @dev Processes all winning and unclaimed fights for the user in the season
    /// @param seasonId The season ID
    function claim(uint256 seasonId) external nonReentrant {
        require(seasons[seasonId].resolved, "SB-9");

        uint256 settlementTime = seasons[seasonId].settlementTime;
        require(block.timestamp >= settlementTime, "SB-20");
        require(block.timestamp <= settlementTime + CLAIM_WINDOW, "SB-19");

        // Get seasonTokenId from season struct
        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");

        // Get number of fights for this season
        uint256 numFights = seasons[seasonId].numFights;
        require(numFights > 0, "SB-12");

        uint256 totalPayoutAmount = 0;
        uint256 claimedCount = 0;

        // Process each fight in the season (fight IDs are 0, 1, 2, ... numFights-1)
        for (uint256 fightId = 0; fightId < numFights; fightId++) {
            Position storage position = userPositions[msg.sender][seasonId][fightId];
            
            // Skip if position doesn't exist or already claimed
            if (position.stakeAmount == 0 || position.claimed) {
                continue;
            }

            // Get winning outcome for this fight
            FightState storage fightState = fightStates[seasonId][fightId];
            uint256 fightWinningOutcome = fightState.winningOutcome;
            
            // Check if user's outcome matches the winner (bit 2)
            uint256 userWinner = (position.outcome >> 2) & 1;
            uint256 winningFighterIndex = (fightWinningOutcome >> 2) & 1;
            
            // Skip if user didn't pick the correct winner
            if (userWinner != winningFighterIndex) {
                continue;
            }

            // Get FP per share for this fight (calculated during resolution, truncated down)
            uint256 fpPerShareValue = fightState.fpPerShare;
            if (fpPerShareValue == 0) {
                continue;
            }

            // Calculate user's points from outcome (3 for winner, 4 for winner + method)
            uint256 userPoints = calculatePoints(position.outcome, fightWinningOutcome);
            if (userPoints == 0) {
                continue;
            }

            // Calculate user's winnings: fpPerShare * userPoints * userStake
            // Formula: userWinnings = fpPerShare * userPoints * position.stakeAmount
            // This calculates how much the user should receive based on their points and stake
            uint256 userWinnings = fpPerShareValue * userPoints * position.stakeAmount;
            uint256 fightPayout = position.stakeAmount + userWinnings;

            // Mark position as claimed
            position.claimed = true;
            
            // Add to total payout
            totalPayoutAmount += fightPayout;
            claimedCount++;

            emit Claimed(msg.sender, seasonId, fightId, fightPayout);
        }

        // Require at least one position was claimed
        require(claimedCount > 0, "SB-11");
        require(totalPayoutAmount > 0, "SB-11");

        // Transfer total FP tokens to user in a single transaction
        IERC1155(fpContract).safeTransferFrom(address(this), msg.sender, seasonTokenId, totalPayoutAmount, "");
    }

    // ============ VIEW FUNCTIONS ============

    /// @notice Get pool information for a specific outcome
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @param outcome The outcome to query
    /// @return totalStaked Total FP staked in this pool
    function getPoolInfo(
        uint256 seasonId,
        uint256 fightId,
        uint256 outcome
    ) external view returns (uint256 totalStaked) {
        Pool storage pool = pools[seasonId][fightId][outcome];
        return pool.totalStaked;
    }

    /// @notice Get all pools information for a fight
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return outcomes Array of outcome values
    /// @return totalStakedArray Array of total staked per outcome
    function getFightPools(
        uint256 seasonId,
        uint256 fightId
    ) external view returns (
        uint256[] memory outcomes,
        uint256[] memory totalStakedArray
    ) {
        FightConfig storage config = fights[seasonId][fightId];
        require(config.numOutcomes > 0, "SB-12"); // Fight must exist (numOutcomes > 0 means fight exists)

        uint256 numOutcomes = config.numOutcomes;
        outcomes = new uint256[](numOutcomes);
        totalStakedArray = new uint256[](numOutcomes);

        for (uint256 i = 0; i < numOutcomes; i++) {
            Pool storage pool = pools[seasonId][fightId][i];
            outcomes[i] = i;
            totalStakedArray[i] = pool.totalStaked;
        }
    }

    /// @notice Get fight resolution data
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return fpPerShareValue FP per share (truncated down, 0 if not settled)
    /// @return winningOutcomeValue The winning outcome (0 if not settled)
    function getFightResolutionData(
        uint256 seasonId,
        uint256 fightId
    ) external view returns (
        uint256 fpPerShareValue,
        uint256 winningOutcomeValue
    ) {
        FightState storage fightState = fightStates[seasonId][fightId];
        return (
            fightState.fpPerShare,
            fightState.winningOutcome
        );
    }

    /// @notice Calculate winnings for a position (if resolved and winner is correct)
    /// @param user The user address
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return canClaim Whether the position can be claimed (has correct winner)
    /// @return userPoints Points earned by the user (3 for winner, 4 for winner + method)
    /// @return userWinnings Winnings amount (0 if cannot claim)
    /// @return totalPayout Total payout (stake + winnings)
    /// @return claimed Whether the position has been claimed
    function getPositionWinnings(
        address user,
        uint256 seasonId,
        uint256 fightId
    ) external view returns (
        bool canClaim,
        uint256 userPoints,
        uint256 userWinnings,
        uint256 totalPayout,
        bool claimed
    ) {
        Position storage position = userPositions[user][seasonId][fightId];
        require(position.stakeAmount > 0, "SB-12"); // Position must exist

        claimed = position.claimed;

        // Check if season is resolved
        if (!seasons[seasonId].resolved) {
            return (false, 0, 0, 0, claimed);
        }

        // Check if fight is settled (fpPerShare > 0 means fight is resolved)
        FightState storage fightState = fightStates[seasonId][fightId];
        uint256 fpPerShareValue = fightState.fpPerShare;
        if (fpPerShareValue == 0) {
            return (false, 0, 0, 0, claimed);
        }

        // Get winning outcome for this fight
        uint256 fightWinningOutcome = fightState.winningOutcome;
        
        // Check if user's outcome matches the winner (bit 2)
        uint256 userWinner = (position.outcome >> 2) & 1;
        uint256 winningFighterIndex = (fightWinningOutcome >> 2) & 1;

        if (userWinner != winningFighterIndex) {
            return (false, 0, 0, 0, claimed);
        }

        // Calculate user's points from outcome (3 for winner, 4 for winner + method)
        userPoints = calculatePoints(position.outcome, fightWinningOutcome);
        
        // Get FP per share for this fight (calculated during resolution, truncated down)
        // fpPerShareValue already checked above, so we know it's > 0
        if (userPoints == 0) {
            return (false, 0, 0, 0, claimed);
        }

        // Calculate user's winnings: fpPerShare * userPoints * userStake
        userWinnings = fpPerShareValue * userPoints * position.stakeAmount;
        totalPayout = position.stakeAmount + userWinnings;

        return (true, userPoints, userWinnings, totalPayout, claimed);
    }

    /// @notice Check if a position has been claimed
    /// @param user The user address
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return claimed Whether the position has been claimed
    function isPositionClaimed(
        address user,
        uint256 seasonId,
        uint256 fightId
    ) external view returns (bool claimed) {
        Position storage position = userPositions[user][seasonId][fightId];
        require(position.stakeAmount > 0, "SB-12"); // Position must exist
        return position.claimed;
    }

    /// @notice Get position details
    /// @param user The user address
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return position The position struct
    function getPosition(
        address user,
        uint256 seasonId,
        uint256 fightId
    ) external view returns (Position memory position) {
        position = userPositions[user][seasonId][fightId];
        require(position.stakeAmount > 0, "SB-12"); // Position must exist
    }

    /// @notice Get total points for a user in a season
    /// @param user The user address
    /// @param seasonId The season ID
    /// @return totalPoints Total points earned by the user in the season
    function getUserTotalPointsInSeason(
        address user,
        uint256 seasonId
    ) external view returns (uint256 totalPoints) {
        uint256 numFights = seasons[seasonId].numFights;
        for (uint256 i = 0; i < numFights; i++) {
            Position storage pos = userPositions[user][seasonId][i];
            if (pos.stakeAmount > 0) {
                // Check if fight is settled (fpPerShare > 0 means fight is resolved)
                FightState storage fightState = fightStates[seasonId][i];
                if (fightState.fpPerShare > 0) {
                    uint256 fightWinningOutcome = fightState.winningOutcome;
                    uint256 points = calculatePoints(pos.outcome, fightWinningOutcome);
                    totalPoints += points;
                }
            }
        }
    }

    /// @notice Get points breakdown for a user in a season
    /// @param user The user address
    /// @param seasonId The season ID
    /// @return totalPoints Total points earned
    /// @return positionsWithPoints Number of positions with points > 0
    /// @return positionsWith3Points Number of positions with 3 points (winner only)
    /// @return positionsWith4Points Number of positions with 4 points (winner + method)
    function getUserPointsBreakdown(
        address user,
        uint256 seasonId
    ) external view returns (
        uint256 totalPoints,
        uint256 positionsWithPoints,
        uint256 positionsWith3Points,
        uint256 positionsWith4Points
    ) {
        uint256 numFights = seasons[seasonId].numFights;
        for (uint256 i = 0; i < numFights; i++) {
            Position storage pos = userPositions[user][seasonId][i];
            if (pos.stakeAmount > 0) {
                uint256 points = 0;
                // Check if fight is settled (fpPerShare > 0 means fight is resolved)
                FightState storage fightState = fightStates[seasonId][i];
                if (fightState.fpPerShare > 0) {
                    uint256 fightWinningOutcome = fightState.winningOutcome;
                    points = calculatePoints(pos.outcome, fightWinningOutcome);
                }
                totalPoints += points;
                if (points > 0) {
                    positionsWithPoints++;
                    if (points == 3) {
                        positionsWith3Points++;
                    } else if (points == 4) {
                        positionsWith4Points++;
                    }
                }
            }
        }
    }
 

    /// @notice Calculate points for a position based on outcome matching
    /// @dev Points system: 3 points for correct winner, +1 point for correct method = 4 total
    /// @dev Outcome encoding: bits 0-1 = method (0=Submission, 1=Decision, 2=KO/TKO), bit 2 = winner (0=A, 1=B)
    /// @param userOutcome The outcome selected by the user
    /// @param winningOutcome The winning outcome
    /// @return points Points earned (3 for winner only, 4 for winner + method)
    function calculatePoints(uint256 userOutcome, uint256 winningOutcome) public pure returns (uint256 points) {
        // Extract winner (bit 2) and method (bits 0-1)
        uint256 userWinner = (userOutcome >> 2) & 1;
        uint256 winningFighterIndex = (winningOutcome >> 2) & 1;
        uint256 userMethod = userOutcome & 0x3;
        uint256 winningMethod = winningOutcome & 0x3;
        
        // 3 points if correct winner, +1 if also correct method, 0 if wrong winner
        points = (userWinner == winningFighterIndex) 
            ? ((userMethod == winningMethod) ? 4 : 3)
            : 0;
    }

    /// @notice Seed prize pool for a fight
    /// @dev Can only be called by ADMIN_ROLE
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @param fpAmount Amount of FP tokens to add to prize pool for this fight
    function seedPrizePool(
        uint256 seasonId,
        uint256 fightId,
        uint256 fpAmount
    ) external onlyRole(ADMIN_ROLE) {
        require(seasons[seasonId].cutOffTime > 0, "SB-12");
        require(fpAmount > 0, "SB-17");
        
        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");
        
        // Transfer FP tokens from admin to contract
        IERC1155(fpContract).safeTransferFrom(msg.sender, address(this), seasonTokenId, fpAmount, "");
        
        fightStates[seasonId][fightId].prizePool += fpAmount;

        emit PrizePoolSeeded(seasonId, fightId, fpAmount);
    }

    /// @notice Recover remaining balance after claim window expires
    /// @dev Can only be called by ADMIN_ROLE after claim window expires
    /// @dev Transfers all remaining balance of seasonTokenId in the contract
    /// @param seasonId The season ID
    /// @param recipient Address to receive the remaining balance
    function recoverRemainingBalance(
        uint256 seasonId,
        address recipient
    ) external onlyRole(ADMIN_ROLE) {
        require(seasons[seasonId].resolved, "SB-9");
        require(recipient != address(0), "SB-1");
        
        uint256 settlementTime = seasons[seasonId].settlementTime;
        require(block.timestamp > settlementTime + CLAIM_WINDOW, "SB-19"); // Claim window must have expired
        
        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");
        
        // Get all remaining balance for this seasonTokenId
        uint256 remainingBalance = IERC1155(fpContract).balanceOf(address(this), seasonTokenId);
        require(remainingBalance > 0, "SB-13");
        
        // Transfer all remaining balance to recipient
        IERC1155(fpContract).safeTransferFrom(address(this), recipient, seasonTokenId, remainingBalance, "");
        emit RemainingBalanceRecovered(recipient, seasonId, remainingBalance);
    }

    /// @notice Pause the contract
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpause the contract
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Set FP1155 contract address
    /// @param _fpContract New FP1155 contract address
    function setFPContract(address _fpContract) external onlyRole(ADMIN_ROLE) {
        require(_fpContract != address(0), "SB-2");
        address oldContract = fpContract;
        fpContract = _fpContract;
        emit FPContractUpdated(oldContract, _fpContract);
    }

    /// @notice Authorize upgrade
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ADMIN_ROLE) {
        require(newImplementation != address(0));
    }

    /// @notice Check if contract supports interface
    /// @dev Override to combine supportsInterface from AccessControlEnumerableUpgradeable and ERC1155HolderUpgradeable
    function supportsInterface(bytes4 interfaceId) public view virtual override(AccessControlEnumerableUpgradeable, ERC1155HolderUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // Storage gap for future upgrades
    uint256[50] private __gap;
}
