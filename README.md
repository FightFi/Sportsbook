# Sportsbook Contract - Technical Specifications

## General Description

The **Sportsbook** contract is a prediction market system for UFC fights. Users can make predictions on multiple fights in a season, stake FP tokens (ERC1155), and claim winnings based on the accuracy of their predictions.

## Main Features

### 1. Season System
- Each season contains multiple fights
- Fights are identified with sequential indices (0, 1, 2, ... n-1)
- Each season has a specific ERC1155 token (`seasonTokenId`)
- Each season has a time limit (`cutOffTime`) for making predictions
- All fights in a season are resolved together

### 2. Prediction System
- Users can make predictions only once per fight per season
- Users can predict specific fights in a season (not necessarily all fights)
- Each fight has multiple possible outcomes
- Each outcome has a minimum and maximum bet range

### 3. Points System
- **3 points**: If the user correctly predicted the winner (but not the method)
- **4 points**: If the user correctly predicted the winner AND the method
- **0 points**: If the user incorrectly predicted the winner

### 4. Outcome Encoding
Outcomes are encoded in a `uint256`:
- **Bits 0-1**: Victory method
  - `0` = Submission
  - `1` = Decision
  - `2` = KO/TKO
- **Bit 2**: Winner
  - `0` = Fighter A won
  - `1` = Fighter B won

### 5. Prize Distribution System
- **Winners pool**: Formed with:
  - Losers' tokens (stakes from outcomes with incorrect winner)
  - Fight-specific prize pool (if exists)
- **Proportional distribution**: Winners receive a proportional share based on:
  - Their points (3 or 4)
  - Their stake
- **Formula**: `userWinnings = fpPerShare * userPoints * userStake`
- **Total payout**: `stakeAmount + userWinnings`

### 6. Claim Window
- **Duration**: 72 hours after resolution
- Users can claim all their winning fights in a single transaction
- After the window, admin can recover remaining balance

## Contract Functionalities

### Administration Functions (ADMIN_ROLE)

#### `createSeasonWithFights`
Creates a season with all its fights in a single transaction.

**Parameters:**
- `seasonId`: Unique season ID
- `cutOffTime`: Timestamp limit for making predictions
- `seasonTokenId`: ERC1155 token ID for this season
- `fightConfigs[]`: Array of fight configurations (minBet, maxBet, numOutcomes)
- `fightPrizePoolAmounts[]`: Array of prize pools per fight (can be 0)

**Behavior:**
- Validates that the season doesn't exist
- Transfers prize pools to the contract
- Creates all fights with sequential IDs (0, 1, 2, ...)

#### `resolveSeason`
Resolves all fights in a season with their winning outcomes.

**Parameters:**
- `seasonId`: Season ID
- `winningOutcomes[]`: Array of winning outcomes (one per fight)

**Behavior:**
- Calculates winners pool for each fight
- Calculates `fpPerShare` for each fight (truncated division)
- Marks season as resolved
- Sets settlement time

#### `seedPrizePool`
Adds tokens to the prize pool of a specific fight.

**Parameters:**
- `seasonId`: Season ID
- `fightId`: Fight ID
- `fpAmount`: Amount of FP tokens to add

#### `recoverRemainingBalance`
Recovers remaining balance after the claim window expires.

**Parameters:**
- `seasonId`: Season ID
- `recipient`: Address that will receive the balance

**Behavior:**
- Can only be called after claim window expires (72 hours)
- Transfers all remaining balance of `seasonTokenId` in the contract

### User Functions

#### `lockPredictionsBatch`
Allows a user to make predictions for specific fights in a season.

**Parameters:**
- `seasonId`: Season ID
- `fightIds[]`: Array of fight IDs to bet on (must be valid and unique)
- `outcomes[]`: Array of selected outcomes (one per fightId)
- `stakes[]`: Array of stakes (one per fightId)

**Validations:**
- Season must exist
- Must be before `cutOffTime`
- Season must not be resolved
- User must not have made predictions before for each fight in this season
- Arrays must have the same length and at least one element
- Fight IDs must be unique and within valid range
- Each stake must be between minBet and maxBet

**Behavior:**
- Transfers all user's FP tokens to the contract
- Creates positions for each fight
- Updates outcome pools
- Updates fighter stake counters

#### `claim`
Allows a user to claim all their winnings from a season in a single transaction.

**Parameters:**
- `seasonId`: Season ID

**Validations:**
- Season must be resolved
- Must be within claim window (72 hours)
- User must have at least one unclaimed winning position

**Behavior:**
- Iterates over all fights in the season
- Processes only fights where the user:
  - Has a position
  - Hasn't claimed before
  - Correctly predicted the winner
- Calculates winnings for each winning fight
- Sums everything and makes a single transfer
- Marks all positions as claimed

### Query Functions (View)

#### `getPoolInfo`
Gets information about a specific pool (outcome of a fight).

#### `getFightPools`
Gets information about all pools of a fight.

#### `getFightResolutionData`
Gets resolution data of a fight (fpPerShare, winningOutcome).

#### `getPositionWinnings`
Calculates potential winnings of a specific position.

#### `isPositionClaimed`
Checks if a position has been claimed.

#### `getPosition`
Gets position details.

#### `getUserTotalPointsInSeason`
Calculates total points of a user in a season.

#### `getUserPointsBreakdown`
Gets detailed points breakdown of a user in a season.

## Data Structures

### Season
```solidity
struct Season {
    uint256 cutOffTime;        // Time limit for predictions
    uint256 seasonTokenId;     // ERC1155 token ID
    uint256 numFights;         // Number of fights
    bool resolved;             // If resolved
    uint256 settlementTime;    // Resolution time
}
```

### FightConfig
```solidity
struct FightConfig {
    uint256 minBet;            // Minimum bet
    uint256 maxBet;            // Maximum bet
    uint256 numOutcomes;       // Number of possible outcomes
}
```

### FightState
```solidity
struct FightState {
    uint256 prizePool;         // Fight prize pool
    uint256 fighterAStaked;    // Total staked for Fighter A
    uint256 fighterBStaked;    // Total staked for Fighter B
    uint256 fpPerShare;        // FP per share (0 if not resolved)
    uint256 winningOutcome;    // Winning outcome (0 if not resolved)
}
```

### Position
```solidity
struct Position {
    uint256 outcome;          // Selected outcome
    uint256 stakeAmount;       // Staked amount
    bool claimed;              // If claimed
}
```

## Events

- `SeasonCreated`: Emitted when a season is created
- `PredictionLocked`: Emitted when a user makes a prediction
- `FightResolved`: Emitted when a fight is resolved
- `PrizePoolSeeded`: Emitted when prize pool is added to
- `Claimed`: Emitted when a user claims winnings
- `RemainingBalanceRecovered`: Emitted when remaining balance is recovered

## Security

- **ReentrancyGuard**: Protection against reentrancy attacks
- **AccessControl**: Only ADMIN_ROLE can execute administrative functions
- **Pausable**: Contract can be paused in case of emergency
- **UUPS Upgradeable**: Contract is upgradeable via UUPS proxy

## Important Considerations

1. **Truncated Division**: `fpPerShare` is calculated with truncated division, leaving a remainder that is not distributed. This remainder can be recovered after the claim window.

2. **Sequential Fight IDs**: Fight IDs are always sequential from 0 (0, 1, 2, ... n-1). Arbitrary IDs cannot be used.

3. **One Prediction per Fight per Season**: Each user can only make predictions once per fight per season.

4. **Complete Resolution**: All fights in a season are resolved together in a single transaction.

5. **General Claim**: Users can claim all their winning fights of a season in a single transaction by calling `claim(seasonId)`.
