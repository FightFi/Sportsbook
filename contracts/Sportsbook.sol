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

    // Constants
    uint256 public constant CLAIM_WINDOW = 72 hours; // Claim window duration
    uint256 private constant POINTS_WINNER_ONLY = 3; // Points for correct winner only
    uint256 private constant POINTS_WINNER_AND_METHOD = 4; // Points for correct winner and method
    uint256 private constant PERCENTAGE_BASE = 100; // Base for percentage calculations (100 = 100%)

    // State variables
    address public fpContract; // FP1155 contract address

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
        uint256 fighterAUsers; // Number of users who bet on fighter A
        uint256 fighterBUsers; // Number of users who bet on fighter B
        uint256 winningOutcome; // Winning outcome (0 if not resolved)
        uint256 totalWinningsPool; // Total winnings pool (loser stakes + prize pool) - stored to avoid overflow
        uint256 winningPoolTotalShares; // Total shares in winning pool - stored to avoid overflow
    }

    struct Pool {
        uint256 totalStaked; // Total FP staked in this pool
    }

    struct Position {
        uint256 outcome; // Outcome selected by user
        uint256 stakeAmount; // Amount of FP staked
        bool claimed; // Whether winnings have been claimed
    }

    // Mappings
    mapping(uint256 => Season) public seasons; // seasonId => Season struct
    mapping(uint256 => mapping(uint256 => FightConfig)) public fights; // seasonId => fightId => FightConfig
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Pool)))
        public pools; // seasonId => fightId => outcome => Pool
    mapping(uint256 => mapping(uint256 => FightState)) public fightStates; // seasonId => fightId => FightState
    mapping(address => mapping(uint256 => mapping(uint256 => Position)))
        public userPositions; // user => seasonId => fightId => Position

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
        uint8 winningOutcome
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
        require(_admin != address(0), "SB-1");

        fpContract = _fpContract;

        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ MAIN FUNCTIONS ============

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
        // Ensure number of fights doesn't exceed 256 (required for bitmask optimization)
        require(fightConfigs.length <= 256, "SB-12");

        // Calculate total fight prize pool amount to transfer (unchecked is safe here)
        uint256 totalFightPrizePool = 0;
        for (uint256 i = 0; i < fightPrizePoolAmounts.length; ) {
            totalFightPrizePool += fightPrizePoolAmounts[i];
            unchecked {
                ++i;
            }
        }

        // Transfer all fight prize pool tokens at once (if any)
        if (totalFightPrizePool > 0) {
            IERC1155(fpContract).safeTransferFrom(
                msg.sender,
                address(this),
                seasonTokenId,
                totalFightPrizePool,
                ""
            );
        }

        // Create season
        seasons[seasonId] = Season({
            cutOffTime: cutOffTime,
            seasonTokenId: seasonTokenId,
            numFights: fightConfigs.length,
            resolved: false,
            settlementTime: 0
        });

        emit SeasonCreated(
            seasonId,
            cutOffTime,
            seasonTokenId,
            fightConfigs.length
        );

        // Create all fights and set prize pools
        // Fight IDs are sequential starting from 0 (0, 1, 2, ... n-1)
        // Cache mappings to reduce storage reads
        mapping(uint256 => FightConfig) storage seasonFights = fights[seasonId];
        mapping(uint256 => FightState) storage seasonFightStates = fightStates[seasonId];
        
        for (uint256 i = 0; i < fightConfigs.length; ) {
            uint256 fightId = i;
            FightConfig calldata cfg = fightConfigs[i];
            uint256 prizePoolAmount = fightPrizePoolAmounts[i];

            require(seasonFights[fightId].numOutcomes == 0, "SB-12"); // Fight must not exist
            require(cfg.minBet > 0 && cfg.maxBet >= cfg.minBet, "SB-16");
            require(cfg.numOutcomes >= 2, "SB-11");

            seasonFights[fightId] = cfg;

            // Initialize fight state
            seasonFightStates[fightId] = FightState({
                prizePool: prizePoolAmount,
                fighterAStaked: 0,
                fighterBStaked: 0,
                fighterAUsers: 0,
                fighterBUsers: 0,
                winningOutcome: 0,
                totalWinningsPool: 0,
                winningPoolTotalShares: 0
            });

            unchecked {
                ++i;
            }
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
        // Cache season data to reduce storage reads
        Season storage season = seasons[seasonId];
        
        // Validate season exists (cutOffTime > 0 means season exists)
        uint256 cutOffTime = season.cutOffTime;
        require(cutOffTime > 0, "SB-12");

        // Validate season is still open for predictions (before cutOffTime)
        require(block.timestamp <= cutOffTime, "SB-15");

        // Season must not be resolved
        require(!season.resolved, "SB-9");

        // Get seasonTokenId from season struct
        uint256 seasonTokenId = season.seasonTokenId;
        require(seasonTokenId > 0, "SB-12");

        // Get number of fights for this season
        uint256 numFights = season.numFights;
        require(numFights > 0, "SB-12");

        // Validate arrays have same length
        require(fightIds.length == outcomes.length, "SB-12");
        require(fightIds.length == stakes.length, "SB-12");
        require(fightIds.length > 0, "SB-12");

        // Cache fights mapping to reduce storage reads
        mapping(uint256 => FightConfig) storage seasonFights = fights[seasonId];
        mapping(uint256 => FightState) storage seasonFightStates = fightStates[seasonId];
        mapping(uint256 => Position) storage userSeasonPositions = userPositions[msg.sender][seasonId];

        // Validate fightIds are unique and within valid range (O(n) instead of O(n²))
        // Use bitmask to track seen fightIds (fights never exceed 256, so bitmask always works)
        uint256 seenFightIds = 0;
        for (uint256 i = 0; i < fightIds.length; ) {
            uint256 fightId = fightIds[i];

            // Validate fightId is within valid range
            require(fightId < numFights, "SB-12");

            // Check for duplicates using bitmask (O(1) check instead of O(n))
            // Since fights never exceed 256, bitmask always works
            uint256 bit = 1 << fightId;
            require((seenFightIds & bit) == 0, "SB-12"); // Duplicate detected
            seenFightIds |= bit;

            // Validate fight exists (numOutcomes > 0 means fight exists)
            require(seasonFights[fightId].numOutcomes > 0, "SB-12");

            // Validate user doesn't already have a position in this fight
            require(userSeasonPositions[fightId].stakeAmount == 0, "SB-23");

            unchecked {
                ++i;
            }
        }

        // Calculate total stake amount (unchecked is safe here as we validate individual stakes)
        uint256 totalStake = 0;
        for (uint256 i = 0; i < stakes.length; ) {
            totalStake += stakes[i];
            unchecked {
                ++i;
            }
        }

        // Require at least one bet (totalStake > 0)
        require(totalStake > 0, "SB-10");

        // Check FP balance
        require(
            IERC1155(fpContract).balanceOf(msg.sender, seasonTokenId) >=
                totalStake,
            "SB-13"
        );

        // Transfer total FP tokens from user to contract
        IERC1155(fpContract).safeTransferFrom(
            msg.sender,
            address(this),
            seasonTokenId,
            totalStake,
            ""
        );

        // Create positions for each specified fight
        for (uint256 i = 0; i < fightIds.length; ) {
            uint256 fightId = fightIds[i];
            uint256 outcome = outcomes[i];
            uint256 fpStake = stakes[i];

            FightConfig storage config = seasonFights[fightId];
            require(outcome < config.numOutcomes, "SB-11"); // Valid outcome implies fight exists
            require(
                fpStake >= config.minBet && fpStake <= config.maxBet,
                "SB-10"
            );

            // Create position
            userSeasonPositions[fightId] = Position({
                outcome: outcome,
                stakeAmount: fpStake,
                claimed: false
            });

            // Add stake to outcome pool
            pools[seasonId][fightId][outcome].totalStaked += fpStake;

            // Update fighter staked counters and user counters (bit 2: 0 = fighter A, 1 = fighter B)
            uint256 fighter = (outcome >> 2) & 1;
            if (fighter == 0) {
                seasonFightStates[fightId].fighterAStaked += fpStake;
                // Increment user count for fighter A (unchecked is safe as it's a counter)
                unchecked {
                    seasonFightStates[fightId].fighterAUsers += 1;
                }
            } else {
                seasonFightStates[fightId].fighterBStaked += fpStake;
                // Increment user count for fighter B (unchecked is safe as it's a counter)
                unchecked {
                    seasonFightStates[fightId].fighterBUsers += 1;
                }
            }

            emit PredictionLocked(
                msg.sender,
                seasonId,
                fightId,
                outcome,
                fpStake
            );

            unchecked {
                ++i;
            }
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

        // Cache mappings to reduce storage reads
        mapping(uint256 => FightConfig) storage seasonFights = fights[seasonId];
        mapping(uint256 => FightState) storage seasonFightStates = fightStates[seasonId];
        mapping(uint256 => mapping(uint256 => Pool)) storage seasonPools = pools[seasonId];

        // Resolve each fight (fightIds are sequential: 0, 1, 2, ...)
        for (uint256 i = 0; i < winningOutcomes.length; ) {
            uint8 winningOutcome = winningOutcomes[i];
            uint256 fightId = i;

            // Cache config and fightState to reduce storage reads
            FightConfig storage config = seasonFights[fightId];
            FightState storage fightState = seasonFightStates[fightId];
            uint256 numOutcomes = config.numOutcomes;
            
            require(winningOutcome < numOutcomes, "SB-11"); // Valid outcome implies fight exists

            // Extract winning fighter index (bit 2) and method (bits 0-1)
            // winningFighterIndex: 0 = fighterA won, 1 = fighterB won
            uint256 winningFighterIndex = (winningOutcome >> 2) & 1;
            uint256 winningMethod = winningOutcome & 0x3;

            // Calculate total weighted shares for winning outcomes
            // winningPoolTotalShares: Total weighted shares in winning pool (denominator for FP payout calculation)
            //   - 4 shares per stake if outcome matches exactly (same winner + same method)
            //   - 3 shares per stake if only winner matches (same winner, different method)
            uint256 winningPoolTotalShares = 0;
            mapping(uint256 => Pool) storage fightPools = seasonPools[fightId];

            for (uint256 j = 0; j < numOutcomes; ) {
                uint256 outcomeStaked = fightPools[j].totalStaked;
                
                // Skip if no stakes in this outcome
                if (outcomeStaked != 0) {
                    // Check if this outcome is a winning outcome (same winner)
                    // winningFighterIndex: 0 = fighterA won, 1 = fighterB won
                    uint256 outcomeWinner = (j >> 2) & 1;
                    if (outcomeWinner == winningFighterIndex) {
                        // Calculate shares for this outcome:
                        // - POINTS_WINNER_AND_METHOD shares per stake if method matches exactly (same winner + same method)
                        // - POINTS_WINNER_ONLY shares per stake if only winner matches (same winner, different method)
                        uint256 outcomeMethod = j & 0x3;
                        uint256 sharesPerStake = (outcomeMethod == winningMethod) ? POINTS_WINNER_AND_METHOD : POINTS_WINNER_ONLY;
                        winningPoolTotalShares += outcomeStaked * sharesPerStake;
                    }
                }
                unchecked {
                    ++j;
                }
            }

            // Calculate total loser stakes directly from fighter counters (more efficient)
            // totalLoserStakes: Sum of stakes from all losing outcomes (different winner)
            uint256 totalLoserStakes = (winningFighterIndex == 0)
                ? fightState.fighterBStaked
                : fightState.fighterAStaked;

            // totalWinningsPool: Complete prize pool for winners (calculated PER FIGHT, not per season)
            //   - totalLoserStakes: Loser pools (tokens from losing bets in this fight)
            //   - fightState.prizePool: Prize pool specific to this fight
            // This pool will be distributed proportionally among all winning positions in THIS FIGHT
            uint256 totalWinningsPool = totalLoserStakes + fightState.prizePool;

            // Math explanation:
            // - winningPoolTotalShares = Σ(outcomeStaked * sharesPerStake) for all winning outcomes
            // - userWinnings = (totalWinningsPool * userPoints * userStake) / winningPoolTotalShares
            // - The formula DOES account for user investment (userStake) proportionally
            // - Note: Division truncation may leave residual funds (recoverable via recoverRemainingBalance)
            // Require winningPoolTotalShares > 0 to avoid division by zero
            require(winningPoolTotalShares > 0, "SB-18"); // Must have at least one winner

            // Store resolution data (store values directly to avoid overflow in calculations)
            // Calculate directly: userWinnings = (totalWinningsPool * userShares) / winningPoolTotalShares
            // This avoids overflow from multiplying by large multipliers
            fightState.totalWinningsPool = totalWinningsPool;
            fightState.winningPoolTotalShares = winningPoolTotalShares;
            fightState.winningOutcome = uint256(winningOutcome);

            emit FightResolved(seasonId, fightId, winningOutcome);

            unchecked {
                ++i;
            }
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
        // Cache season data to reduce storage reads
        Season storage season = seasons[seasonId];
        require(season.resolved, "SB-9");

        uint256 settlementTime = season.settlementTime;
        require(block.timestamp >= settlementTime, "SB-20");
        require(block.timestamp <= settlementTime + CLAIM_WINDOW, "SB-19");

        uint256 seasonTokenId = season.seasonTokenId;
        require(seasonTokenId > 0, "SB-12");

        uint256 numFights = season.numFights;
        require(numFights > 0, "SB-12");

        uint256 totalPayoutAmount = 0;

        // Cache mappings to reduce storage reads
        mapping(uint256 => Position) storage userSeasonPositions = userPositions[msg.sender][seasonId];
        mapping(uint256 => FightState) storage seasonFightStates = fightStates[seasonId];

        // Process each fight in the season (fight IDs are 0, 1, 2, ... numFights-1)
        for (uint256 fightId = 0; fightId < numFights; ) {
            Position storage position = userSeasonPositions[fightId];

            // Skip if position doesn't exist or already claimed
            uint256 stakeAmount = position.stakeAmount;
            if (stakeAmount == 0 || position.claimed) {
                unchecked {
                    ++fightId;
                }
                continue;
            }

            // Cache fightState to reduce storage reads
            FightState storage fightState = seasonFightStates[fightId];
            
            // Check if fight is settled (totalWinningsPool > 0 means fight is resolved)
            uint256 totalWinningsPool = fightState.totalWinningsPool;
            uint256 winningPoolTotalShares = fightState.winningPoolTotalShares;
            if (totalWinningsPool == 0 || winningPoolTotalShares == 0) {
                unchecked {
                    ++fightId;
                }
                continue;
            }

            // Get winning outcome for this fight
            uint256 fightWinningOutcome = fightState.winningOutcome;

            // Check if user's outcome matches the winner (bit 2)
            uint256 userOutcome = position.outcome;
            uint256 userWinner = (userOutcome >> 2) & 1;
            uint256 winningFighterIndex = (fightWinningOutcome >> 2) & 1;

            // Skip if user didn't pick the correct winner
            if (userWinner != winningFighterIndex) {
                unchecked {
                    ++fightId;
                }
                continue;
            }

            // Calculate user's points from outcome (3 for winner, 4 for winner + method)
            uint256 userPoints = calculatePoints(userOutcome, fightWinningOutcome);
            if (userPoints == 0) {
                unchecked {
                    ++fightId;
                }
                continue;
            }

            // Calculate user's winnings directly: (totalWinningsPool * userShares) / winningPoolTotalShares
            // Formula: userWinnings = (totalWinningsPool * userPoints * stakeAmount) / winningPoolTotalShares
            uint256 userShares = userPoints * stakeAmount;
            uint256 userWinnings = (totalWinningsPool * userShares) / winningPoolTotalShares;
            uint256 fightPayout = stakeAmount + userWinnings;

            // Mark position as claimed
            position.claimed = true;

            // Add to total payout
            totalPayoutAmount += fightPayout;

            emit Claimed(msg.sender, seasonId, fightId, fightPayout);

            unchecked {
                ++fightId;
            }
        }

        // Require at least one position was claimed
        require(totalPayoutAmount > 0, "SB-11");

        // Transfer total FP tokens to user in a single transaction
        IERC1155(fpContract).safeTransferFrom(
            address(this),
            msg.sender,
            seasonTokenId,
            totalPayoutAmount,
            ""
        );
    }

    // ============ UTILITY FUNCTIONS ============

    /// @notice Calculate points for a position based on outcome matching
    /// @dev Points system: 3 points for correct winner, +1 point for correct method = 4 total
    /// @dev Outcome encoding: bits 0-1 = method (0=Submission, 1=Decision, 2=KO/TKO), bit 2 = winner (0=A, 1=B)
    /// @param userOutcome The outcome selected by the user
    /// @param winningOutcome The winning outcome
    /// @return points Points earned (3 for winner only, 4 for winner + method)
    function calculatePoints(
        uint256 userOutcome,
        uint256 winningOutcome
    ) public pure returns (uint256 points) {
        // Extract winner (bit 2) and method (bits 0-1)
        uint256 userWinner = (userOutcome >> 2) & 1;
        uint256 winningFighterIndex = (winningOutcome >> 2) & 1;
        uint256 userMethod = userOutcome & 0x3;
        uint256 winningMethod = winningOutcome & 0x3;

        // Points: POINTS_WINNER_ONLY for correct winner, POINTS_WINNER_AND_METHOD for winner + method, 0 if wrong winner
        points = (userWinner == winningFighterIndex)
            ? ((userMethod == winningMethod) ? POINTS_WINNER_AND_METHOD : POINTS_WINNER_ONLY)
            : 0;
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
    )
        external
        view
        returns (uint256[] memory outcomes, uint256[] memory totalStakedArray)
    {
        FightConfig storage config = fights[seasonId][fightId];
        require(config.numOutcomes > 0, "SB-12"); // Fight must exist (numOutcomes > 0 means fight exists)

        uint256 numOutcomes = config.numOutcomes;
        outcomes = new uint256[](numOutcomes);
        totalStakedArray = new uint256[](numOutcomes);

        for (uint256 i = 0; i < numOutcomes; ) {
            Pool storage pool = pools[seasonId][fightId][i];
            outcomes[i] = i;
            totalStakedArray[i] = pool.totalStaked;
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Get fight resolution data
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return totalWinningsPool Total winnings pool (loser stakes + prize pool)
    /// @return winningPoolTotalShares Total shares in winning pool
    /// @return winningOutcome Winning outcome (0 if not settled)
    function getFightResolutionData(
        uint256 seasonId,
        uint256 fightId
    )
        external
        view
        returns (
            uint256 totalWinningsPool,
            uint256 winningPoolTotalShares,
            uint256 winningOutcome
        )
    {
        FightState storage fightState = fightStates[seasonId][fightId];
        return (
            fightState.totalWinningsPool,
            fightState.winningPoolTotalShares,
            fightState.winningOutcome
        );
    }

    /// @notice Get fight statistics including user counts and probabilities
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @return fighterAUsers Number of users who bet on fighter A
    /// @return fighterBUsers Number of users who bet on fighter B
    /// @return fighterAStaked Total amount staked on fighter A
    /// @return fighterBStaked Total amount staked on fighter B
    /// @return totalUsers Total number of users who bet on this fight
    /// @return fighterAProbability Percentage of users who bet on fighter A (0-100, where 100 = 100%)
    /// @return fighterBProbability Percentage of users who bet on fighter B (0-100, where 100 = 100%)
    function getFightStatistics(
        uint256 seasonId,
        uint256 fightId
    )
        external
        view
        returns (
            uint256 fighterAUsers,
            uint256 fighterBUsers,
            uint256 fighterAStaked,
            uint256 fighterBStaked,
            uint256 totalUsers,
            uint256 fighterAProbability,
            uint256 fighterBProbability
        )
    {
        FightState storage fightState = fightStates[seasonId][fightId];
        
        fighterAUsers = fightState.fighterAUsers;
        fighterBUsers = fightState.fighterBUsers;
        fighterAStaked = fightState.fighterAStaked;
        fighterBStaked = fightState.fighterBStaked;
        totalUsers = fighterAUsers + fighterBUsers;
        
        // Calculate probabilities based on user count (0-100, where 100 = 100%)
        if (totalUsers > 0) {
            fighterAProbability = (fighterAUsers * PERCENTAGE_BASE) / totalUsers;
            fighterBProbability = (fighterBUsers * PERCENTAGE_BASE) / totalUsers;
        } else {
            fighterAProbability = 0;
            fighterBProbability = 0;
        }
        
        return (
            fighterAUsers,
            fighterBUsers,
            fighterAStaked,
            fighterBStaked,
            totalUsers,
            fighterAProbability,
            fighterBProbability
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
    )
        external
        view
        returns (
            bool canClaim,
            uint256 userPoints,
            uint256 userWinnings,
            uint256 totalPayout,
            bool claimed
        )
    {
        Position storage position = userPositions[user][seasonId][fightId];
        uint256 stakeAmount = position.stakeAmount;
        require(stakeAmount > 0, "SB-12"); // Position must exist

        claimed = position.claimed;

        // Check if season is resolved
        if (!seasons[seasonId].resolved) {
            return (false, 0, 0, 0, claimed);
        }

        // Cache fightState to reduce storage reads
        FightState storage fightState = fightStates[seasonId][fightId];
        uint256 totalWinningsPool = fightState.totalWinningsPool;
        uint256 winningPoolTotalShares = fightState.winningPoolTotalShares;
        
        // Check if fight is settled (totalWinningsPool > 0 means fight is resolved)
        if (totalWinningsPool == 0 || winningPoolTotalShares == 0) {
            return (false, 0, 0, 0, claimed);
        }

        // Get winning outcome for this fight
        uint256 fightWinningOutcome = fightState.winningOutcome;

        // Check if user's outcome matches the winner (bit 2)
        uint256 userOutcome = position.outcome;
        uint256 userWinner = (userOutcome >> 2) & 1;
        uint256 winningFighterIndex = (fightWinningOutcome >> 2) & 1;

        if (userWinner != winningFighterIndex) {
            return (false, 0, 0, 0, claimed);
        }

        // Calculate user's points from outcome (3 for winner, 4 for winner + method)
        userPoints = calculatePoints(userOutcome, fightWinningOutcome);

        if (userPoints == 0) {
            return (false, 0, 0, 0, claimed);
        }

        // Calculate user's winnings directly: (totalWinningsPool * userShares) / winningPoolTotalShares
        // Formula: userWinnings = (totalWinningsPool * userPoints * stakeAmount) / winningPoolTotalShares
        uint256 userShares = userPoints * stakeAmount;
        userWinnings = (totalWinningsPool * userShares) / winningPoolTotalShares;
        totalPayout = stakeAmount + userWinnings;

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
        for (uint256 i = 0; i < numFights; ) {
            Position storage pos = userPositions[user][seasonId][i];
            uint256 stakeAmount = pos.stakeAmount;
            
            // Skip if no position
            if (stakeAmount == 0) {
                unchecked {
                    ++i;
                }
                continue;
            }

            // Cache fightState to reduce storage reads
            FightState storage fightState = fightStates[seasonId][i];
            uint256 totalWinningsPool = fightState.totalWinningsPool;
            uint256 winningPoolTotalShares = fightState.winningPoolTotalShares;
            
            // Check if fight is settled (totalWinningsPool > 0 means fight is resolved)
            if (totalWinningsPool > 0 && winningPoolTotalShares > 0) {
                uint256 fightWinningOutcome = fightState.winningOutcome;
                uint256 points = calculatePoints(pos.outcome, fightWinningOutcome);
                totalPoints += points;
            }

            unchecked {
                ++i;
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
    )
        external
        view
        returns (
            uint256 totalPoints,
            uint256 positionsWithPoints,
            uint256 positionsWith3Points,
            uint256 positionsWith4Points
        )
    {
        uint256 numFights = seasons[seasonId].numFights;
        for (uint256 i = 0; i < numFights; ) {
            Position storage pos = userPositions[user][seasonId][i];
            uint256 stakeAmount = pos.stakeAmount;
            
            // Skip if no position
            if (stakeAmount == 0) {
                unchecked {
                    ++i;
                }
                continue;
            }

            uint256 points = 0;
            // Cache fightState to reduce storage reads
            FightState storage fightState = fightStates[seasonId][i];
            uint256 totalWinningsPool = fightState.totalWinningsPool;
            uint256 winningPoolTotalShares = fightState.winningPoolTotalShares;
            
            // Check if fight is settled (totalWinningsPool > 0 means fight is resolved)
            if (totalWinningsPool > 0 && winningPoolTotalShares > 0) {
                uint256 fightWinningOutcome = fightState.winningOutcome;
                points = calculatePoints(pos.outcome, fightWinningOutcome);
            }
            
            totalPoints += points;
            if (points > 0) {
                unchecked {
                    positionsWithPoints++;
                    if (points == POINTS_WINNER_ONLY) {
                        positionsWith3Points++;
                    } else if (points == POINTS_WINNER_AND_METHOD) {
                        positionsWith4Points++;
                    }
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    // ============ PRIZE POOL FUNCTIONS ============

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
        require(!seasons[seasonId].resolved, "SB-9");
        require(fpAmount > 0, "SB-17");

        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");

        // Transfer FP tokens from admin to contract
        IERC1155(fpContract).safeTransferFrom(
            msg.sender,
            address(this),
            seasonTokenId,
            fpAmount,
            ""
        );

        fightStates[seasonId][fightId].prizePool += fpAmount;

        emit PrizePoolSeeded(seasonId, fightId, fpAmount);
    }

    /// @notice Internal function to calculate required seed for a single fight
    /// @param seasonId The season ID
    /// @param fightId The fight ID
    /// @param winningOutcome The expected winning outcome
    /// @return requiredPrizePool The minimum prize pool required
    /// @return currentPrizePool The current prize pool
    /// @return additionalSeedNeeded The additional seed needed
    /// @return estimatedWinners The estimated number of winners
    function _calculateRequiredSeedForFight(
        uint256 seasonId,
        uint256 fightId,
        uint8 winningOutcome
    ) internal view returns (
        uint256 requiredPrizePool,
        uint256 currentPrizePool,
        uint256 additionalSeedNeeded,
        uint256 estimatedWinners
    ) {
        FightConfig storage config = fights[seasonId][fightId];
        FightState storage fightState = fightStates[seasonId][fightId];
        
        require(config.numOutcomes > 0, "SB-12"); // Fight must exist
        require(winningOutcome < config.numOutcomes, "SB-11");
        
        currentPrizePool = fightState.prizePool;
        
        // Extract winning fighter index
        uint256 winningFighterIndex = (winningOutcome >> 2) & 1;
        uint256 winningMethod = winningOutcome & 0x3;
        
        // Calculate winning pool total shares
        uint256 winningPoolTotalShares = 0;
        uint256 totalLoserStakes = 0;
        
        for (uint256 j = 0; j < config.numOutcomes; ) {
            uint256 outcomeStaked = pools[seasonId][fightId][j].totalStaked;
            if (outcomeStaked != 0) {
                uint256 outcomeWinner = (j >> 2) & 1;
                if (outcomeWinner == winningFighterIndex) {
                    uint256 outcomeMethod = j & 0x3;
                    uint256 sharesPerStake = (outcomeMethod == winningMethod) ? POINTS_WINNER_AND_METHOD : POINTS_WINNER_ONLY;
                    winningPoolTotalShares += outcomeStaked * sharesPerStake;
                } else {
                    totalLoserStakes += outcomeStaked;
                }
            }
            unchecked {
                ++j;
            }
        }
        
        // Get actual number of winning users from fight state
        uint256 winningUsers = (winningFighterIndex == 0) 
            ? fightState.fighterAUsers 
            : fightState.fighterBUsers;
        
        estimatedWinners = winningUsers;
        
        // If no winners, return 0
        if (winningPoolTotalShares == 0 || winningUsers == 0) {
            return (0, currentPrizePool, 0, 0);
        }
        
        // Calculate required total winnings pool
        // We need to ensure that each winning user gets at least 1 FP
        // Formula: userWinnings = (totalWinningsPool * userShares) / winningPoolTotalShares >= 1
        // For the worst case (user with minimum shares), we need:
        // totalWinningsPool * minSharesPerUser >= winningPoolTotalShares
        
        // Find minimum shares per stake in winning outcomes
        uint256 minSharesPerStake = type(uint256).max;
        for (uint256 j = 0; j < config.numOutcomes; ) {
            uint256 outcomeStaked = pools[seasonId][fightId][j].totalStaked;
            if (outcomeStaked != 0) {
                uint256 outcomeWinner = (j >> 2) & 1;
                if (outcomeWinner == winningFighterIndex) {
                    uint256 outcomeMethod = j & 0x3;
                    uint256 sharesPerStake = (outcomeMethod == winningMethod) ? POINTS_WINNER_AND_METHOD : POINTS_WINNER_ONLY;
                    if (sharesPerStake < minSharesPerStake) {
                        minSharesPerStake = sharesPerStake;
                    }
                }
            }
            unchecked {
                ++j;
            }
        }
        
        // If we couldn't find any winning outcomes with stakes, return 0
        if (minSharesPerStake == type(uint256).max) {
            return (0, currentPrizePool, 0, 0);
        }
        
        // Calculate required total winnings pool
        // We want: (totalWinningsPool * minSharesPerStake) / winningPoolTotalShares >= 1
        // So: totalWinningsPool * minSharesPerStake >= winningPoolTotalShares
        // Therefore: totalWinningsPool >= winningPoolTotalShares / minSharesPerStake
        // Use ceiling division
        uint256 requiredTotalWinningsPool = (winningPoolTotalShares + minSharesPerStake - 1) / minSharesPerStake;
        
        // Calculate required prize pool
        if (requiredTotalWinningsPool > totalLoserStakes) {
            requiredPrizePool = requiredTotalWinningsPool - totalLoserStakes;
        } else {
            requiredPrizePool = 0; // Loser stakes are enough
        }
        
        // Calculate additional seed needed
        if (requiredPrizePool > currentPrizePool) {
            additionalSeedNeeded = requiredPrizePool - currentPrizePool;
        } else {
            additionalSeedNeeded = 0;
        }
        
        return (requiredPrizePool, currentPrizePool, additionalSeedNeeded, estimatedWinners);
    }

    /// @notice Calculate the minimum prize pool required for all fights in a season
    /// @dev This is a view function that simulates resolution for all fights
    /// @param seasonId The season ID
    /// @param winningOutcomes Array of expected winning outcomes (one per fight)
    /// @return requiredPrizePools Array of minimum prize pools required per fight
    /// @return currentPrizePools Array of current prize pools per fight
    /// @return additionalSeedsNeeded Array of additional seeds needed per fight
    /// @return estimatedWinnersArray Array of estimated winners per fight
    function calculateRequiredSeedForSeason(
        uint256 seasonId,
        uint8[] calldata winningOutcomes
    ) external view returns (
        uint256[] memory requiredPrizePools,
        uint256[] memory currentPrizePools,
        uint256[] memory additionalSeedsNeeded,
        uint256[] memory estimatedWinnersArray
    ) {
        require(seasons[seasonId].cutOffTime > 0, "SB-12");
        require(!seasons[seasonId].resolved, "SB-9");
        
        uint256 numFights = seasons[seasonId].numFights;
        require(numFights > 0, "SB-12");
        require(winningOutcomes.length == numFights, "SB-12");
        
        // Initialize arrays
        requiredPrizePools = new uint256[](numFights);
        currentPrizePools = new uint256[](numFights);
        additionalSeedsNeeded = new uint256[](numFights);
        estimatedWinnersArray = new uint256[](numFights);
        
        // Calculate for each fight
        for (uint256 i = 0; i < numFights; ) {
            (requiredPrizePools[i], currentPrizePools[i], additionalSeedsNeeded[i], estimatedWinnersArray[i]) = 
                _calculateRequiredSeedForFight(seasonId, i, winningOutcomes[i]);
            unchecked {
                ++i;
            }
        }
        
        return (requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray);
    }

    /// @notice Seed prize pools for all fights in a season with automatic calculation
    /// @dev Can be called before resolution to ensure all winners get at least 1 FP
    /// @param seasonId The season ID
    /// @param winningOutcomes Array of expected winning outcomes (one per fight)
    /// @param autoSeed If true, automatically seed the required amounts
    function seedPrizePoolsForSeason(
        uint256 seasonId,
        uint8[] calldata winningOutcomes,
        bool autoSeed
    ) external onlyRole(ADMIN_ROLE) {
        require(seasons[seasonId].cutOffTime > 0, "SB-12");
        require(!seasons[seasonId].resolved, "SB-9");
        
        uint256 numFights = seasons[seasonId].numFights;
        require(numFights > 0, "SB-12");
        require(winningOutcomes.length == numFights, "SB-12");
        
        uint256 seasonTokenId = seasons[seasonId].seasonTokenId;
        require(seasonTokenId > 0, "SB-12");
        
        // Initialize array for additional seeds needed
        uint256[] memory additionalSeedsNeeded = new uint256[](numFights);
        
        uint256 totalAdditionalSeed = 0;
        
        // Calculate for each fight using internal function (only need additionalSeedsNeeded)
        for (uint256 i = 0; i < numFights; ) {
            (, , additionalSeedsNeeded[i], ) = 
                _calculateRequiredSeedForFight(seasonId, i, winningOutcomes[i]);
            
            totalAdditionalSeed += additionalSeedsNeeded[i];

            unchecked {
                ++i;
            }
        }
        
        if (autoSeed && totalAdditionalSeed > 0) {
            // Transfer all additional FP tokens at once
            IERC1155(fpContract).safeTransferFrom(
                msg.sender,
                address(this),
                seasonTokenId,
                totalAdditionalSeed,
                ""
            );
            
            // Distribute to each fight
            for (uint256 i = 0; i < numFights; ) {
                if (additionalSeedsNeeded[i] > 0) {
                    fightStates[seasonId][i].prizePool += additionalSeedsNeeded[i];
                    emit PrizePoolSeeded(seasonId, i, additionalSeedsNeeded[i]);
                }
                unchecked {
                    ++i;
                }
            }
        }
    }

    // ============ ADMIN FUNCTIONS ============

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
        uint256 remainingBalance = IERC1155(fpContract).balanceOf(
            address(this),
            seasonTokenId
        );
        require(remainingBalance > 0, "SB-13");

        // Transfer all remaining balance to recipient
        IERC1155(fpContract).safeTransferFrom(
            address(this),
            recipient,
            seasonTokenId,
            remainingBalance,
            ""
        );
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

    // ============ UPGRADE FUNCTIONS ============

    /// @notice Authorize upgrade
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(ADMIN_ROLE) {
        require(newImplementation != address(0), "SB-2");
    }

    /// @notice Check if contract supports interface
    /// @dev Override to combine supportsInterface from AccessControlEnumerableUpgradeable and ERC1155HolderUpgradeable
    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        virtual
        override(AccessControlEnumerableUpgradeable, ERC1155HolderUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // Storage gap for future upgrades
    uint256[50] private __gap;
}
