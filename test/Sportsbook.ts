import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

// Helper functions
async function deployFP1155(adminAddress: string) {
  const fp1155 = await ethers.deployContract("FP1155", [
    "https://api.example.com/token/",
    adminAddress,
  ]);
  await fp1155.waitForDeployment();
  return fp1155;
}

// Helper function to decode outcome
function decodeOutcome(outcome: bigint): { fighter: string; method: string } {
  const fighter = (outcome >> 2n) & 1n;
  const method = outcome & 3n;
  const fighterName = fighter === 0n ? "Fighter A" : "Fighter B";
  const methodName = method === 0n ? "Submission" : method === 1n ? "Decision" : "KO/TKO";
  return { fighter: fighterName, method: methodName };
}

// Helper function to format outcome
function formatOutcome(outcome: bigint): string {
  const { fighter, method } = decodeOutcome(outcome);
  return `${fighter} - ${method} (outcome ${outcome})`;
}

// Helper function to format FP as integer units (NFTs)
function formatFP(amount: bigint): string {
  return `${amount.toString()} FP`;
}


// Helper function to get total claimable amount for a user in a season
async function getTotalClaimable(
  sportsbook: any,
  userAddress: string,
  seasonId: bigint,
  numFights: number
): Promise<{
  totalClaimable: bigint;
  totalWinnings: bigint;
  totalStake: bigint;
  fightsWithWinnings: number;
  breakdown: Array<{
    fightId: number;
    canClaim: boolean;
    points: bigint;
    winnings: bigint;
    totalPayout: bigint;
    claimed: boolean;
  }>;
}> {
  let totalClaimable = 0n;
  let totalWinnings = 0n;
  let totalStake = 0n;
  let fightsWithWinnings = 0;
  const breakdown: Array<{
    fightId: number;
    canClaim: boolean;
    points: bigint;
    winnings: bigint;
    totalPayout: bigint;
    claimed: boolean;
  }> = [];

  // Check if season is resolved
  const season = await sportsbook.seasons(seasonId);
  const seasonResolved = season.resolved;

  for (let fightId = 0; fightId < numFights; fightId++) {
    try {
      const [canClaim, userPoints, userWinnings, totalPayout, claimed] =
        await sportsbook.getPositionWinnings(userAddress, seasonId, fightId);
      
      // If getPositionWinnings returns canClaim=false but season is resolved,
      // check manually if user has correct winner (fpPerShare might be 0 due to truncation)
      let actualCanClaim = canClaim;
      let actualUserPoints = userPoints;
      let actualUserWinnings = userWinnings;
      let actualTotalPayout = totalPayout;
      
      if (!canClaim && seasonResolved) {
        try {
          // Get position and fight state to check manually
          const position = await sportsbook.getPosition(userAddress, seasonId, fightId);
          if (position.stakeAmount > 0n) {
            const fightState = await sportsbook.fightStates(seasonId, fightId);
            const winningOutcome = fightState.winningOutcome;
            
            // Check if fight is resolved (if season is resolved, all fights are resolved)
            // winningOutcome can be 0 (Fighter A - Submission), so we check if season is resolved
            if (seasonResolved) {
              // Check if user picked correct winner
              const userWinner = (position.outcome >> 2n) & 1n;
              const winningFighterIndex = (winningOutcome >> 2n) & 1n;
              
              if (userWinner === winningFighterIndex) {
                // User has correct winner, calculate points and winnings manually
                const userMethod = position.outcome & 3n;
                const winningMethod = winningOutcome & 3n;
                actualUserPoints = (userMethod === winningMethod) ? 4n : 3n;
                
                // Calculate winnings if fpPerShare > 0
                if (fightState.fpPerShare > 0n) {
                  actualUserWinnings = fightState.fpPerShare * actualUserPoints * position.stakeAmount;
                  actualTotalPayout = position.stakeAmount + actualUserWinnings;
                  actualCanClaim = true;
                } else {
                  // fpPerShare is 0, so no winnings but user has correct winner
                  actualUserWinnings = 0n;
                  actualTotalPayout = position.stakeAmount; // Only recover stake
                  actualCanClaim = true; // User can claim to recover stake
                }
              }
            }
          }
        } catch (e) {
          // Position doesn't exist or error checking
        }
      }
      
      breakdown.push({
        fightId,
        canClaim: actualCanClaim,
        points: actualUserPoints,
        winnings: actualUserWinnings,
        totalPayout: actualTotalPayout,
        claimed,
      });

      if (actualCanClaim && !claimed) {
        totalClaimable += BigInt(actualTotalPayout);
        totalWinnings += BigInt(actualUserWinnings);
        totalStake += BigInt(actualTotalPayout) - BigInt(actualUserWinnings); // stake = totalPayout - winnings
        fightsWithWinnings++;
      }
    } catch (e) {
      // Position doesn't exist for this fight
      breakdown.push({
        fightId,
        canClaim: false,
        points: 0n,
        winnings: 0n,
        totalPayout: 0n,
        claimed: false,
      });
    }
  }

  return {
    totalClaimable,
    totalWinnings,
    totalStake,
    fightsWithWinnings,
    breakdown,
  };
}

// Helper function to print user claimable summary
async function printUserClaimableSummary(
  sportsbook: any,
  userAddress: string,
  userName: string,
  seasonId: bigint,
  numFights: number
) {
  const claimable = await getTotalClaimable(sportsbook, userAddress, seasonId, numFights);
  
  console.log(`\n--- ${userName} Claimable Summary ---`);
  console.log(`  Total Claimable: ${formatFP(claimable.totalClaimable)}`);
  console.log(`  Total Winnings: ${formatFP(claimable.totalWinnings)}`);
  console.log(`  Total Stake (to recover): ${formatFP(claimable.totalStake)}`);
  console.log(`  Fights with winnings: ${claimable.fightsWithWinnings}`);
  
  if (claimable.breakdown.length > 0) {
    console.log(`  Breakdown per fight:`);
    for (const fight of claimable.breakdown) {
      if (fight.canClaim) {
        const status = fight.claimed ? "CLAIMED" : "CAN CLAIM";
        console.log(`    Fight ${fight.fightId}: ${status}`);
        console.log(`      Points: ${fight.points}`);
        console.log(`      Winnings: ${formatFP(fight.winnings)}`);
        console.log(`      Total Payout: ${formatFP(fight.totalPayout)}`);
      }
    }
  }
}

// Helper function to print pool info by outcome for all fights using getFightPools
async function printPoolInfoByOutcome(
  sportsbook: any,
  seasonId: bigint,
  numFights: number
) {
  console.log("\n=== POOL INFO BY OUTCOME ===");
  for (let fightId = 0; fightId < numFights; fightId++) {
    try {
      const [outcomes, totalStakedArray] = await sportsbook.getFightPools(seasonId, fightId);
      
      console.log(`\n--- Fight ${fightId} ---`);
      console.log(`  Total Outcomes: ${outcomes.length}`);
      
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const totalStaked = totalStakedArray[i];
        if (totalStaked > 0n) {
          const { fighter, method } = decodeOutcome(outcome);
          console.log(`    Outcome ${outcome} (${fighter} - ${method}): ${formatFP(totalStaked)}`);
        }
      }
    } catch (e) {
      // Fight doesn't exist or error
      console.log(`\n--- Fight ${fightId} ---`);
      console.log(`  Error: Fight not found`);
    }
  }
}

// Helper function to visualize detailed fight data for math verification
async function visualizeFightDetails(
  sportsbook: any,
  seasonId: bigint,
  fightId: number
) {
  console.log(`\n=== FIGHT ${fightId} DETAILED ANALYSIS ===`);
  
  try {
    // Get fight configuration
    const fightConfig = await sportsbook.fights(seasonId, fightId);
    const fightState = await sportsbook.fightStates(seasonId, fightId);
    
    console.log(`\n--- Configuration ---`);
    console.log(`  Min Bet: ${formatFP(fightConfig.minBet)}`);
    console.log(`  Max Bet: ${formatFP(fightConfig.maxBet)}`);
    console.log(`  Total Outcomes: ${fightConfig.numOutcomes}`);
    console.log(`  Prize Pool: ${formatFP(fightState.prizePool)}`);
    
    // Get all pools
    const [outcomes, totalStakedArray] = await sportsbook.getFightPools(seasonId, fightId);
    
    console.log(`\n--- Pools by Outcome ---`);
    let totalStaked = 0n;
    let fighterAStaked = 0n;
    let fighterBStaked = 0n;
    
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const staked = totalStakedArray[i];
      totalStaked += staked;
      
      // Calculate fighter staked
      const fighter = (outcome >> 2n) & 1n;
      if (fighter === 0n) {
        fighterAStaked += staked;
      } else {
        fighterBStaked += staked;
      }
      
      if (staked > 0n) {
        const { fighter: fighterName, method } = decodeOutcome(outcome);
        console.log(`  Outcome ${outcome}: ${fighterName} - ${method}`);
        console.log(`    Staked: ${formatFP(staked)}`);
      }
    }
    
    console.log(`\n--- Totals ---`);
    console.log(`  Total Staked: ${formatFP(totalStaked)}`);
    console.log(`  Fighter A Staked: ${formatFP(fighterAStaked)}`);
    console.log(`  Fighter B Staked: ${formatFP(fighterBStaked)}`);
    console.log(`  Prize Pool: ${formatFP(fightState.prizePool)}`);
    
    // Get resolution data if resolved
    const season = await sportsbook.seasons(seasonId);
    if (season.resolved) {
      const [totalWinningsPool, winningPoolTotalShares, winningOutcome] = await sportsbook.getFightResolutionData(seasonId, fightId);
      const { fighter: winningFighter, method: winningMethod } = decodeOutcome(winningOutcome);
      
      console.log(`\n--- Resolution ---`);
      console.log(`  Winning Outcome: ${winningOutcome} (${winningFighter} - ${winningMethod})`);
      console.log(`  Total Winnings Pool: ${formatFP(totalWinningsPool)}`);
      console.log(`  Winning Pool Total Shares: ${formatFP(winningPoolTotalShares)}`);
      
      // Note: FP per share is not used directly (division would truncate to 0)
      // Winnings are calculated directly: userWinnings = (totalWinningsPool * userShares) / winningPoolTotalShares
      console.log(`  Formula: userWinnings = (${formatFP(totalWinningsPool)} * userShares) / ${formatFP(winningPoolTotalShares)}`);
      
      // Calculate math breakdown
      const winningFighterIndex = (winningOutcome >> 2n) & 1n;
      const winningMethodValue = winningOutcome & 3n;
      
      console.log(`\n--- Math Breakdown ---`);
      console.log(`  Winning Fighter Index: ${winningFighterIndex} (${winningFighterIndex === 0n ? "Fighter A" : "Fighter B"})`);
      console.log(`  Winning Method: ${winningMethodValue} (${winningMethod})`);
      
      // Calculate winning pool shares (for verification)
      let calculatedWinningPoolTotalShares = 0n;
      let totalLoserStakes = winningFighterIndex === 0n ? fighterBStaked : fighterAStaked;
      
      console.log(`\n  Winning Outcomes Breakdown:`);
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        const outcomeStaked = totalStakedArray[i];
        
        if (outcomeStaked > 0n) {
          const outcomeWinner = (outcome >> 2n) & 1n;
          if (outcomeWinner === winningFighterIndex) {
            const outcomeMethod = outcome & 3n;
            const sharesPerStake = (outcomeMethod === winningMethodValue) ? 4n : 3n;
            const shares = outcomeStaked * sharesPerStake;
            calculatedWinningPoolTotalShares += shares;
            
            const { fighter: fighterName, method: methodName } = decodeOutcome(outcome);
            const matchType = outcomeMethod === winningMethodValue ? "EXACT MATCH (4 shares)" : "WINNER ONLY (3 shares)";
            console.log(`    Outcome ${outcome} (${fighterName} - ${methodName}):`);
            console.log(`      Staked: ${formatFP(outcomeStaked)}`);
            console.log(`      Shares per Stake: ${sharesPerStake}`);
            console.log(`      Total Shares: ${formatFP(shares)} (${matchType})`);
          }
        }
      }
      
      console.log(`\n  Calculation:`);
      console.log(`    Total Loser Stakes: ${formatFP(totalLoserStakes)}`);
      console.log(`    Prize Pool: ${formatFP(fightState.prizePool)}`);
      const calculatedTotalWinningsPool = totalLoserStakes + fightState.prizePool;
      console.log(`    Total Winnings Pool (calculated): ${formatFP(calculatedTotalWinningsPool)} (loser stakes + prize pool)`);
      console.log(`    Winning Pool Total Shares (calculated): ${formatFP(calculatedWinningPoolTotalShares)}`);
      
      // Compare with stored values
      if (winningPoolTotalShares > 0n) {
        console.log(`    Stored Total Winnings Pool: ${formatFP(totalWinningsPool)}`);
        console.log(`    Stored Winning Pool Total Shares: ${formatFP(winningPoolTotalShares)}`);
        console.log(`    Match: ${calculatedTotalWinningsPool === totalWinningsPool && calculatedWinningPoolTotalShares === winningPoolTotalShares ? "✓" : "✗"}`);
        console.log(`    Formula: userWinnings = (${formatFP(totalWinningsPool)} * userShares) / ${formatFP(winningPoolTotalShares)}`);
      }
    } else {
      console.log(`\n--- Resolution ---`);
      console.log(`  Status: Not resolved yet`);
    }
  } catch (e) {
    console.log(`  Error: ${e}`);
  }
}

// Helper function to visualize fights
async function visualizeFights(sportsbook: any, seasonId: bigint, numFights: number) {
  console.log("\n=== FIGHT INFORMATION ===");
  for (let fightId = 0; fightId < numFights; fightId++) {
    const fightConfig = await sportsbook.fights(seasonId, fightId);
    const fightState = await sportsbook.fightStates(seasonId, fightId);
    
    console.log(`\n--- Fight ${fightId} ---`);
    console.log(`  Min Bet: ${formatFP(fightConfig.minBet)}`);
    console.log(`  Max Bet: ${formatFP(fightConfig.maxBet)}`);
    console.log(`  Outcomes: ${fightConfig.numOutcomes}`);
    console.log(`  Prize Pool: ${formatFP(fightState.prizePool)}`);
    console.log(`  Fighter A Staked: ${formatFP(fightState.fighterAStaked)}`);
    console.log(`  Fighter B Staked: ${formatFP(fightState.fighterBStaked)}`);
    
    // Get pools for this fight
    const [outcomes, totalStakedArray] = await sportsbook.getFightPools(seasonId, fightId);
    console.log(`  Pools:`);
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const staked = totalStakedArray[i];
      const { fighter, method } = decodeOutcome(outcome);
      if (staked > 0n) {
        console.log(`    ${formatOutcome(outcome)}: ${formatFP(staked)}`);
      }
    }
    
    // Show resolution if resolved
    const season = await sportsbook.seasons(seasonId);
    if (season.resolved) {
      const [totalWinningsPool, winningPoolTotalShares, winningOutcome] = await sportsbook.getFightResolutionData(seasonId, fightId);
      if (totalWinningsPool > 0n && winningPoolTotalShares > 0n) {
        console.log(`  RESOLVED:`);
        console.log(`    Winning Outcome: ${formatOutcome(winningOutcome)}`);
        console.log(`    Total Winnings Pool: ${formatFP(totalWinningsPool)}`);
        console.log(`    Winning Pool Total Shares: ${formatFP(winningPoolTotalShares)}`);
        console.log(`    Formula: userWinnings = (${formatFP(totalWinningsPool)} * userShares) / ${formatFP(winningPoolTotalShares)}`);
      }
    }
  }
}

// Helper function to visualize user bets
async function visualizeUserBets(
  sportsbook: any,
  seasonId: bigint,
  users: any[],
  userNames: string[],
  numFights: number
) {
  console.log("\n=== USER BETS ===");
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const userName = userNames[i] || `User${i + 1}`;
    console.log(`\n--- ${userName} (${user.address.slice(0, 10)}...) ---`);
    
    let hasBets = false;
    for (let fightId = 0; fightId < numFights; fightId++) {
      try {
        const position = await sportsbook.getPosition(user.address, seasonId, fightId);
        if (position.stakeAmount > 0n) {
          hasBets = true;
          const outcomeStr = formatOutcome(position.outcome);
          console.log(`  Fight ${fightId}: ${outcomeStr}`);
          console.log(`    Stake: ${formatFP(position.stakeAmount)}`);
          console.log(`    Claimed: ${position.claimed ? "Yes" : "No"}`);
          
          // Show winnings if resolved
          const season = await sportsbook.seasons(seasonId);
          if (season.resolved) {
            try {
              // If season is resolved, try to get position winnings
              // This will work even if fpPerShare is very small
              const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
                await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
              if (canClaim) {
                console.log(`    Points: ${userPoints}`);
                console.log(`    Winnings: ${formatFP(userWinnings)}`);
                console.log(`    Total Payout: ${formatFP(totalPayout)}`);
              } else {
                // Check if user picked wrong winner
                const fightState = await sportsbook.fightStates(seasonId, fightId);
                const winningOutcome = fightState.winningOutcome;
                const userWinner = (position.outcome >> 2n) & 1n;
                const winningFighterIndex = (winningOutcome >> 2n) & 1n;
                if (userWinner !== winningFighterIndex) {
                  console.log(`    Status: Lost (wrong fighter)`);
                } else {
                  console.log(`    Status: Lost (wrong method)`);
                }
              }
            } catch (e) {
              // Position might not exist or not resolved yet
              console.log(`    Status: Error checking winnings`);
            }
          } else {
            console.log(`    Status: Season not resolved yet`);
          }
        }
      } catch (e) {
        // Position doesn't exist for this fight
      }
    }
    
    if (!hasBets) {
      console.log(`  No bets placed`);
    }
  }
}

async function deploySportsbook(fp1155Address: string, adminAddress: string) {
  // Deploy implementation
  const SportsbookFactory = await ethers.getContractFactory("Sportsbook");
  const implementation = await SportsbookFactory.deploy();
  await implementation.waitForDeployment();
  
  // Encode initialize call
  const initData = SportsbookFactory.interface.encodeFunctionData("initialize", [fp1155Address, adminAddress]);
  
  // Deploy ERC1967Proxy
  const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967ProxyWrapper");
  const proxy = await ERC1967ProxyFactory.deploy(await implementation.getAddress(), initData);
  await proxy.waitForDeployment();
  
  // Return proxy connected to Sportsbook interface
  return SportsbookFactory.attach(await proxy.getAddress());
}

async function setupContracts() {
  const [admin, ...users] = await ethers.getSigners();

  // Deploy contracts
  const fp1155 = await deployFP1155(admin.address);
  const fp1155Address = await fp1155.getAddress();
  const sportsbook = await deploySportsbook(fp1155Address, admin.address);

  // Grant MINTER_ROLE to admin
  const MINTER_ROLE = await fp1155.MINTER_ROLE();
  await fp1155.grantRole(MINTER_ROLE, admin.address);

  // Grant TRANSFER_AGENT_ROLE to Sportsbook
  const TRANSFER_AGENT_ROLE = await fp1155.TRANSFER_AGENT_ROLE();
  await fp1155.grantRole(TRANSFER_AGENT_ROLE, await sportsbook.getAddress());

  return {
    fp1155,
    sportsbook,
    admin,
    users,
  };
}

describe("Sportsbook", function () {
  it("Should deploy contracts correctly", async function () {
    const { fp1155, sportsbook } = await setupContracts();

    expect(await fp1155.getAddress()).to.be.properAddress;
    expect(await sportsbook.getAddress()).to.be.properAddress;
  });

  it("Should grant TRANSFER_AGENT_ROLE to Sportsbook", async function () {
    const { fp1155, sportsbook, admin } = await setupContracts();

    const sportsbookAddress = await sportsbook.getAddress();

    // Verify TRANSFER_AGENT_ROLE was granted
    const TRANSFER_AGENT_ROLE = await fp1155.TRANSFER_AGENT_ROLE();
    expect(await fp1155.hasRole(TRANSFER_AGENT_ROLE, sportsbookAddress)).to.be.true;
    expect(await fp1155.endpointAllowed(sportsbookAddress)).to.be.true;

    // Mint some tokens to admin
    const seasonTokenId = 1n;
    const amount = 1000n; // NFTs are integers
    await fp1155.mint(admin.address, seasonTokenId, amount, "0x");

    // Verify balance
    expect(await fp1155.balanceOf(admin.address, seasonTokenId)).to.equal(amount);
  });

  it.only("Single fight analysis: Fight 0 only", async function () {
    const { fp1155, sportsbook, admin, users } = await setupContracts();
    const [user1, user2, user3] = users;
    const sportsbookAddress = await sportsbook.getAddress();
    const TRANSFER_AGENT_ROLE = await fp1155.TRANSFER_AGENT_ROLE();
    expect(await fp1155.hasRole(TRANSFER_AGENT_ROLE, sportsbookAddress)).to.be.true;
    expect(await fp1155.endpointAllowed(sportsbookAddress)).to.be.true;
    
    // ============ STEP 1: Create Season 1 with 1 fight (Fight 0) ============
    const seasonId = 1n;
    const seasonTokenId = 1n;
    const latestBlock = await ethers.provider.getBlock("latest");
    const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n; // 1 day from now

    // 1 fight with 6 outcomes (Fighter A/B x 3 methods)
    const fightConfigs = [{
      minBet: 10n, // NFTs are integers
      maxBet: 100n, // NFTs are integers
      numOutcomes: 6,
    }];

    // Prize pool: 100 FP for fight 0
    const fightPrizePoolAmounts = [100n]; // NFTs are integers

    // Mint FP tokens to admin for prize pool
    const totalPrizePool = 100n; // NFTs are integers
    await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");

    // Add admin to allowlist so they can transfer tokens
    await fp1155.setTransferAllowlist(admin.address, true);
    // Approve Sportsbook to spend admin's FP tokens (needed for prize pool transfer)
    await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);

    // Create season
    await expect(
      sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      )
    ).to.emit(sportsbook, "SeasonCreated")
      .withArgs(seasonId, cutOffTime, seasonTokenId, 1n);

    // ============ STEP 2: Users make predictions on Fight 0 only ============
    // Mint FP tokens to users (100 FP each)
    const userBalance = 100n; // NFTs are integers
    await fp1155.mint(user1.address, seasonTokenId, userBalance, "0x");
    await fp1155.mint(user2.address, seasonTokenId, userBalance, "0x");
    await fp1155.mint(user3.address, seasonTokenId, userBalance, "0x");

    // Verify initial balances
    const initialBalance1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const initialBalance2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const initialBalance3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceAfterMint = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    expect(initialBalance1).to.equal(userBalance);
    expect(initialBalance2).to.equal(userBalance);
    expect(initialBalance3).to.equal(userBalance);
    expect(contractBalanceAfterMint).to.equal(totalPrizePool);

    // Add users to allowlist so they can transfer tokens
    await fp1155.setTransferAllowlist(user1.address, true);
    await fp1155.setTransferAllowlist(user2.address, true);
    await fp1155.setTransferAllowlist(user3.address, true);

    // Approve Sportsbook to spend FP tokens
    await fp1155.connect(user1).setApprovalForAll(await sportsbook.getAddress(), true);
    await fp1155.connect(user2).setApprovalForAll(await sportsbook.getAddress(), true);
    await fp1155.connect(user3).setApprovalForAll(await sportsbook.getAddress(), true);

    // Define stakes
    const stake1 = 20n;
    const stake2 = 30n;
    const stake3 = 25n;

    console.log("\n=== TEST CASE: Single Fight Analysis ===");
    console.log(`Setup: User1 bets ${formatFP(stake1)} on outcome 0 (Fighter A, Submission)`);
    console.log(`       User2 bets ${formatFP(stake2)} on outcome 1 (Fighter A, Decision)`);
    console.log(`       User3 bets ${formatFP(stake3)} on outcome 0 (Fighter A, Submission)`);

    // User1: Bets on Fight 0 (outcome 0 = Fighter A, Submission)
    await sportsbook.connect(user1).lockPredictionsBatch(
      seasonId,
      [0n],
      [0n],
      [stake1]
    );

    // User2: Bets on Fight 0 (outcome 1 = Fighter A, Decision)
    await sportsbook.connect(user2).lockPredictionsBatch(
      seasonId,
      [0n],
      [1n],
      [stake2]
    );

    // User3: Bets on Fight 0 (outcome 0 = Fighter A, Submission)
    await sportsbook.connect(user3).lockPredictionsBatch(
      seasonId,
      [0n],
      [0n],
      [stake3]
    );

    // Verify balances after predictions
    const balanceAfterPredictions1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const balanceAfterPredictions2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const balanceAfterPredictions3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceAfterPredictions = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const totalStakes = stake1 + stake2 + stake3;
    
    expect(balanceAfterPredictions1).to.equal(userBalance - stake1);
    expect(balanceAfterPredictions2).to.equal(userBalance - stake2);
    expect(balanceAfterPredictions3).to.equal(userBalance - stake3);
    expect(contractBalanceAfterPredictions).to.equal(totalPrizePool + totalStakes);

    // ============ STEP 3: Resolve Season (Fight 0 only) ============
    // Winning outcome: Fight 0: 0 (Fighter A, Submission) - User1 and User3 win
    const winningOutcomes = [0];
    const expectedWinningOutcome = BigInt(winningOutcomes[0]);

    await expect(
      sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes)
    ).to.emit(sportsbook, "FightResolved");

    // Get fight state and calculate expected values
    const fightState = await sportsbook.fightStates(seasonId, 0);
    const fightConfig = await sportsbook.fights(seasonId, 0);
    
    // Get positions to calculate shares
    const position1Before = await sportsbook.getPosition(user1.address, seasonId, 0);
    const position2Before = await sportsbook.getPosition(user2.address, seasonId, 0);
    const position3Before = await sportsbook.getPosition(user3.address, seasonId, 0);
    
    // Calculate expected winning pool total shares dynamically
    // User1: outcome 0 (exact match) = 4 shares
    // User2: outcome 1 (winner only) = 3 shares
    // User3: outcome 0 (exact match) = 4 shares
    const [canClaim1Before, userPoints1Before, , , ] = 
      await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
    const [canClaim2Before, userPoints2Before, , , ] = 
      await sportsbook.getPositionWinnings(user2.address, seasonId, 0);
    const [canClaim3Before, userPoints3Before, , , ] = 
      await sportsbook.getPositionWinnings(user3.address, seasonId, 0);
    
    const expectedWinningPoolTotalShares = 
      (userPoints1Before * position1Before.stakeAmount) +
      (userPoints2Before * position2Before.stakeAmount) +
      (userPoints3Before * position3Before.stakeAmount);
    
    // Calculate expected total winnings pool (prize pool + loser stakes)
    const winningFighterIndex = (expectedWinningOutcome >> 2n) & 1n;
    const expectedTotalLoserStakes = winningFighterIndex === 0n 
      ? fightState.fighterBStaked 
      : fightState.fighterAStaked;
    const expectedTotalWinningsPool = fightState.prizePool + expectedTotalLoserStakes;

    // Verify resolution data
    const [totalWinningsPool, winningPoolTotalShares, winningOutcome] = 
      await sportsbook.getFightResolutionData(seasonId, 0);
    expect(winningOutcome).to.equal(expectedWinningOutcome);
    expect(totalWinningsPool).to.equal(expectedTotalWinningsPool);
    expect(winningPoolTotalShares).to.equal(expectedWinningPoolTotalShares);
    
    console.log(`\nResolution: Winning outcome ${winningOutcome} (${decodeOutcome(winningOutcome).fighter} - ${decodeOutcome(winningOutcome).method})`);
    console.log(`           Total Winnings Pool: ${formatFP(totalWinningsPool)}`);
    console.log(`           Winning Pool Total Shares: ${formatFP(winningPoolTotalShares)}`);
   
    // ============ STEP 4: Users claim winnings ============
  
    // User1 should have winnings from Fight 0 (exact match, 4 shares)
    const balanceBefore1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceBeforeClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const [canClaim1, userPoints1, userWinnings1, totalPayout1, claimed1] = 
      await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
    const position1 = await sportsbook.getPosition(user1.address, seasonId, 0);
    
    expect(canClaim1).to.be.true;
    expect(userPoints1).to.be.gt(0n); // Should have points (exact match = 4)
    expect(claimed1).to.be.false;
    // Calculate expected winnings dynamically
    const user1Shares = userPoints1 * position1.stakeAmount; // userPoints * stake
    const expectedWinnings1 = (totalWinningsPool * user1Shares) / winningPoolTotalShares;
    expect(userWinnings1).to.equal(expectedWinnings1);
    expect(totalPayout1).to.equal(position1.stakeAmount + expectedWinnings1);
    
    await expect(sportsbook.connect(user1).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceAfterClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    expect(balanceAfter1).to.equal(balanceBefore1 + totalPayout1);
    expect(contractBalanceAfterClaim1).to.equal(contractBalanceBeforeClaim1 - totalPayout1);

    // User2 should have winnings from Fight 0 (winner only, 3 shares)
    const balanceBefore2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const contractBalanceBeforeClaim2 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const [canClaim2, userPoints2, userWinnings2, totalPayout2, claimed2] = 
      await sportsbook.getPositionWinnings(user2.address, seasonId, 0);
    const position2 = await sportsbook.getPosition(user2.address, seasonId, 0);
    
    expect(canClaim2).to.be.true;
    expect(userPoints2).to.be.gt(0n); // Should have points (winner only = 3)
    expect(claimed2).to.be.false;
    // Calculate expected winnings dynamically
    const user2Shares = userPoints2 * position2.stakeAmount; // userPoints * stake
    const expectedWinnings2 = (totalWinningsPool * user2Shares) / winningPoolTotalShares;
    expect(userWinnings2).to.equal(expectedWinnings2);
    expect(totalPayout2).to.equal(position2.stakeAmount + expectedWinnings2);
    
    await expect(sportsbook.connect(user2).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const contractBalanceAfterClaim2 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    expect(balanceAfter2).to.equal(balanceBefore2 + totalPayout2);
    expect(contractBalanceAfterClaim2).to.equal(contractBalanceBeforeClaim2 - totalPayout2);

    // User3 should have winnings from Fight 0 (exact match, 4 shares)
    const balanceBefore3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceBeforeClaim3 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const [canClaim3, userPoints3, userWinnings3, totalPayout3, claimed3] = 
      await sportsbook.getPositionWinnings(user3.address, seasonId, 0);
    const position3 = await sportsbook.getPosition(user3.address, seasonId, 0);
    
    expect(canClaim3).to.be.true;
    expect(userPoints3).to.be.gt(0n); // Should have points (exact match = 4)
    expect(claimed3).to.be.false;
    // Calculate expected winnings dynamically
    const user3Shares = userPoints3 * position3.stakeAmount; // userPoints * stake
    const expectedWinnings3 = (totalWinningsPool * user3Shares) / winningPoolTotalShares;
    expect(userWinnings3).to.equal(expectedWinnings3);
    expect(totalPayout3).to.equal(position3.stakeAmount + expectedWinnings3);
    
    await expect(sportsbook.connect(user3).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceAfterClaim3 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    expect(balanceAfter3).to.equal(balanceBefore3 + totalPayout3);
    expect(contractBalanceAfterClaim3).to.equal(contractBalanceBeforeClaim3 - totalPayout3);

    // Verify final balances and totals
    expect(balanceAfter1).to.equal(balanceBefore1 + totalPayout1);
    expect(balanceAfter2).to.equal(balanceBefore2 + totalPayout2);
    expect(balanceAfter3).to.equal(balanceBefore3 + totalPayout3);
    
    // Verify total payout and remainder
    const totalWinningsPaid = userWinnings1 + userWinnings2 + userWinnings3;
    const calculatedTotalStakes = position1.stakeAmount + position2.stakeAmount + position3.stakeAmount;
    const totalPayout = calculatedTotalStakes + totalWinningsPaid;
    const expectedRemainder = (totalPrizePool + calculatedTotalStakes) - totalPayout;
    expect(contractBalanceAfterClaim3).to.equal(expectedRemainder);
    
    console.log(`\n=== RESULTS SUMMARY ===`);
    console.log(`User1: ${formatFP(userWinnings1)} winnings + ${formatFP(position1.stakeAmount)} stake = ${formatFP(totalPayout1)} total`);
    console.log(`User2: ${formatFP(userWinnings2)} winnings + ${formatFP(position2.stakeAmount)} stake = ${formatFP(totalPayout2)} total`);
    console.log(`User3: ${formatFP(userWinnings3)} winnings + ${formatFP(position3.stakeAmount)} stake = ${formatFP(totalPayout3)} total`);
    console.log(`Total Winnings Paid: ${formatFP(totalWinningsPaid)}`);
    console.log(`Total Payout: ${formatFP(totalPayout)}`);
    console.log(`Remainder in Contract: ${formatFP(expectedRemainder)} (truncation remainder)`);
    
    // Verify all positions are claimed
    const [canClaim1After, , , , claimed1After] = await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
    const [canClaim2After, , , , claimed2After] = await sportsbook.getPositionWinnings(user2.address, seasonId, 0);
    const [canClaim3After, , , , claimed3After] = await sportsbook.getPositionWinnings(user3.address, seasonId, 0);
    expect(claimed1After).to.be.true;
    expect(claimed2After).to.be.true;
    expect(claimed3After).to.be.true;
  });
  
  it("Complete flow: Create season, predictions, resolution and payouts", async function () {
    const { fp1155, sportsbook, admin, users } = await setupContracts();
    const [user1, user2, user3] = users;
    const sportsbookAddress = await sportsbook.getAddress();
    const TRANSFER_AGENT_ROLE = await fp1155.TRANSFER_AGENT_ROLE();
    expect(await fp1155.hasRole(TRANSFER_AGENT_ROLE, sportsbookAddress)).to.be.true;
    expect(await fp1155.endpointAllowed(sportsbookAddress)).to.be.true;
    // ============ STEP 1: Create Season 1 with 5 fights ============
    const seasonId = 1n;
    const seasonTokenId = 1n;
    const latestBlock = await ethers.provider.getBlock("latest");
    const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n; // 1 day from now

    // 5 fights, each with 6 outcomes (Fighter A/B x 3 methods)
    const fightConfigs = Array(5).fill({
      minBet: 10n, // NFTs are integers
      maxBet: 100n, // NFTs are integers
      numOutcomes: 6,
    });

    // Prize pool: 100 FP per fight = 500 FP total
    const fightPrizePoolAmounts = Array(5).fill(100n); // NFTs are integers

    // Mint FP tokens to admin for prize pools
    const totalPrizePool = 500n; // NFTs are integers
    await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");

    // Add admin to allowlist so they can transfer tokens
    await fp1155.setTransferAllowlist(admin.address, true);
    // Approve Sportsbook to spend admin's FP tokens (needed for prize pool transfer)
    await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);

    // Create season
    await expect(
      sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      )
    ).to.emit(sportsbook, "SeasonCreated")
      .withArgs(seasonId, cutOffTime, seasonTokenId, 5n);

    // ============ STEP 2: Users make predictions ============
    // Mint FP tokens to users (100 FP each)
    const userBalance = 100n; // NFTs are integers
    await fp1155.mint(user1.address, seasonTokenId, userBalance, "0x");
    await fp1155.mint(user2.address, seasonTokenId, userBalance, "0x");
    await fp1155.mint(user3.address, seasonTokenId, userBalance, "0x");

    // Print initial balances after minting
    console.log("\n=== BALANCES AFTER MINTING ===");
    const initialBalance1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const initialBalance2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const initialBalance3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceAfterMint = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    console.log(`User1 balance (100 FP each): ${formatFP(initialBalance1)}`);
    console.log(`User2 balance (100 FP each): ${formatFP(initialBalance2)}`);
    console.log(`User3 balance (100 FP each): ${formatFP(initialBalance3)}`);
    console.log(`Sportsbook contract balance (500 FP): ${formatFP(contractBalanceAfterMint)}`);

    // Add users to allowlist so they can transfer tokens
    await fp1155.setTransferAllowlist(user1.address, true);
    await fp1155.setTransferAllowlist(user2.address, true);
    await fp1155.setTransferAllowlist(user3.address, true);

    // Approve Sportsbook to spend FP tokens
    await fp1155.connect(user1).setApprovalForAll(await sportsbook.getAddress(), true);
    await fp1155.connect(user2).setApprovalForAll(await sportsbook.getAddress(), true);
    await fp1155.connect(user3).setApprovalForAll(await sportsbook.getAddress(), true);

    // User1: Bets 20 FP on Fight 0 (outcome 0 = Fighter A, Submission)
    //        Bets 20 FP on Fight 1 (outcome 0 = Fighter A, Submission)
    //        Bets 20 FP on Fight 2 (outcome 3 = Fighter B, Decision)
    await sportsbook.connect(user1).lockPredictionsBatch(
      seasonId,
      [0n, 1n, 2n],
      [0n, 0n, 3n],
      [20n, 20n, 20n] // NFTs are integers
    );

    // User2: Bets 30 FP on Fight 0 (outcome 1 = Fighter A, Decision)
    //        Bets 30 FP on Fight 1 (outcome 4 = Fighter B, KO/TKO)
    await sportsbook.connect(user2).lockPredictionsBatch(
      seasonId,
      [0n, 1n],
      [1n, 4n],
      [30n, 30n] // NFTs are integers
    );

    // User3: Bets 25 FP on Fight 0 (outcome 0 = Fighter A, Submission)
    //        Bets 25 FP on Fight 3 (outcome 0 = Fighter A, Submission)
    //        Bets 25 FP on Fight 4 (outcome 0 = Fighter A, Submission)
    await sportsbook.connect(user3).lockPredictionsBatch(
      seasonId,
      [0n, 3n, 4n],
      [0n, 0n, 0n],
      [25n, 25n, 25n] // NFTs are integers
    );

    // Verify balances after predictions
    const balanceAfterPredictions1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const balanceAfterPredictions2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const balanceAfterPredictions3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    
    const contractBalanceAfterPredictions = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    
    console.log("\n=== BALANCES AFTER PREDICTIONS ===");
    console.log(`User1 balance: ${formatFP(balanceAfterPredictions1)} (bet: 60 FP)`);
    console.log(`User2 balance: ${formatFP(balanceAfterPredictions2)} (bet: 60 FP)`);
    console.log(`User3 balance: ${formatFP(balanceAfterPredictions3)} (bet: 75 FP)`);
    console.log(`Sportsbook contract balance: ${formatFP(contractBalanceAfterPredictions)} (prize pool: ${formatFP(totalPrizePool)}})`);
    
    expect(balanceAfterPredictions1).to.equal(40n); // 100 - 60, NFTs are integers
    expect(balanceAfterPredictions2).to.equal(40n); // 100 - 60, NFTs are integers
    expect(balanceAfterPredictions3).to.equal(25n); // 100 - 75, NFTs are integers
    
    // Visualize fights and user bets after predictions
    await visualizeFights(sportsbook, seasonId, 5);
    await visualizeUserBets(sportsbook, seasonId, [user1, user2, user3], ["User1", "User2", "User3"], 5);

    // ============ STEP 3: Resolve Season ============
    // Winning outcomes:
    // Fight 0: 0 (Fighter A, Submission) - User1 and User3 win
    // Fight 1: 0 (Fighter A, Submission) - User1 wins
    // Fight 2: 3 (Fighter B, Decision) - User1 wins
    // Fight 3: 0 (Fighter A, Submission) - User3 wins
    // Fight 4: 0 (Fighter A, Submission) - User3 wins
    const winningOutcomes = [0, 0, 3, 0, 0];

    // Move time forward past cutOffTime
    // await ethers.provider.send("evm_increaseTime", [86401]);
    // await ethers.provider.send("evm_mine", []);

    await expect(
      sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes)
    ).to.emit(sportsbook, "FightResolved");

    // Visualize fights after resolution
    await visualizeFights(sportsbook, seasonId, 5);
   
    // Show claimable amounts for each user
    console.log("\n=== USER CLAIMABLE AMOUNTS ===");
    await printUserClaimableSummary(sportsbook, user1.address, "User1", seasonId, 5);
    await printUserClaimableSummary(sportsbook, user2.address, "User2", seasonId, 5);
    await printUserClaimableSummary(sportsbook, user3.address, "User3", seasonId, 5);
   
    // Print pool info by outcome before claim
    await printPoolInfoByOutcome(sportsbook, seasonId, 5);
   
    // Visualize detailed fight 0 data for math verification
    await visualizeFightDetails(sportsbook, seasonId, 0);
   
    // ============ STEP 4: Users claim winnings ============
  
    // User1 should have winnings from Fight 0, 1, and 2
    const balanceBefore1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceBeforeClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    await expect(sportsbook.connect(user1).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    const balanceAfter1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceAfterClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const winnings1 = balanceAfter1 - balanceBefore1;
    const contractPayout1 = contractBalanceBeforeClaim1 - contractBalanceAfterClaim1;
    console.log(`User1 balance after claim: ${formatFP(balanceAfter1)}`);
    console.log(`User1 winnings: ${formatFP(winnings1)}`);
    console.log(`Sportsbook contract balance after User1 claim: ${formatFP(contractBalanceAfterClaim1)} (paid out: ${formatFP(contractPayout1)})`);
    expect(balanceAfter1).to.be.gt(balanceBefore1);
 
  });


});
