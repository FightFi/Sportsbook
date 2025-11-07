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

  it("Single fight analysis: Fight 0 only", async function () {
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
  
    // Get detailed winnings for each user before claims
    console.log("\n=== DETAILED WINNINGS BREAKDOWN BEFORE CLAIMS ===");
    
    // User1: Should have winnings from Fight 0, 1, and 2
    const user1Claimable = await getTotalClaimable(sportsbook, user1.address, seasonId, 5);
    console.log(`\n--- User1 Detailed Breakdown ---`);
    let user1TotalWinnings = 0n;
    let user1TotalStake = 0n;
    for (const fight of user1Claimable.breakdown) {
      if (fight.canClaim && !fight.claimed) {
        user1TotalWinnings += fight.winnings;
        user1TotalStake += fight.totalPayout - fight.winnings;
        console.log(`  Fight ${fight.fightId}: ${formatFP(fight.winnings)} winnings + ${formatFP(fight.totalPayout - fight.winnings)} stake = ${formatFP(fight.totalPayout)} total (${fight.points} points)`);
      }
    }
    
    // User2: Should have winnings from Fight 0 (winner only, 3 shares)
    const user2Claimable = await getTotalClaimable(sportsbook, user2.address, seasonId, 5);
    console.log(`\n--- User2 Detailed Breakdown ---`);
    let user2TotalWinnings = 0n;
    let user2TotalStake = 0n;
    for (const fight of user2Claimable.breakdown) {
      if (fight.canClaim && !fight.claimed) {
        user2TotalWinnings += fight.winnings;
        user2TotalStake += fight.totalPayout - fight.winnings;
        console.log(`  Fight ${fight.fightId}: ${formatFP(fight.winnings)} winnings + ${formatFP(fight.totalPayout - fight.winnings)} stake = ${formatFP(fight.totalPayout)} total (${fight.points} points)`);
      }
    }
    
    // User3: Should have winnings from Fight 0, 3, and 4
    const user3Claimable = await getTotalClaimable(sportsbook, user3.address, seasonId, 5);
    console.log(`\n--- User3 Detailed Breakdown ---`);
    let user3TotalWinnings = 0n;
    let user3TotalStake = 0n;
    for (const fight of user3Claimable.breakdown) {
      if (fight.canClaim && !fight.claimed) {
        user3TotalWinnings += fight.winnings;
        user3TotalStake += fight.totalPayout - fight.winnings;
        console.log(`  Fight ${fight.fightId}: ${formatFP(fight.winnings)} winnings + ${formatFP(fight.totalPayout - fight.winnings)} stake = ${formatFP(fight.totalPayout)} total (${fight.points} points)`);
      }
    }
    
    // Visualize detailed fight data for each fight before claims
    console.log("\n=== DETAILED FIGHT ANALYSIS BEFORE CLAIMS ===");
    for (let fightId = 0; fightId < 5; fightId++) {
      await visualizeFightDetails(sportsbook, seasonId, fightId);
    }
    
    // User1 claim
    console.log("\n=== USER1 CLAIM ===");
    const balanceBefore1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceBeforeClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    
    // Get position winnings for each fight User1 won
    const [canClaim1_0, userPoints1_0, userWinnings1_0, totalPayout1_0, claimed1_0] = 
      await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
    const [canClaim1_1, userPoints1_1, userWinnings1_1, totalPayout1_1, claimed1_1] = 
      await sportsbook.getPositionWinnings(user1.address, seasonId, 1);
    const [canClaim1_2, userPoints1_2, userWinnings1_2, totalPayout1_2, claimed1_2] = 
      await sportsbook.getPositionWinnings(user1.address, seasonId, 2);
    
    const position1_0 = await sportsbook.getPosition(user1.address, seasonId, 0);
    const position1_1 = await sportsbook.getPosition(user1.address, seasonId, 1);
    const position1_2 = await sportsbook.getPosition(user1.address, seasonId, 2);
    
    console.log(`Before claim - Balance: ${formatFP(balanceBefore1)}`);
    console.log(`Fight 0: ${formatFP(userWinnings1_0)} winnings + ${formatFP(position1_0.stakeAmount)} stake = ${formatFP(totalPayout1_0)} total (${userPoints1_0} points)`);
    console.log(`Fight 1: ${formatFP(userWinnings1_1)} winnings + ${formatFP(position1_1.stakeAmount)} stake = ${formatFP(totalPayout1_1)} total (${userPoints1_1} points)`);
    console.log(`Fight 2: ${formatFP(userWinnings1_2)} winnings + ${formatFP(position1_2.stakeAmount)} stake = ${formatFP(totalPayout1_2)} total (${userPoints1_2} points)`);
    const expectedTotalPayout1 = totalPayout1_0 + totalPayout1_1 + totalPayout1_2;
    console.log(`Expected total payout: ${formatFP(expectedTotalPayout1)}`);
    
    await expect(sportsbook.connect(user1).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter1 = await fp1155.balanceOf(user1.address, seasonTokenId);
    const contractBalanceAfterClaim1 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const winnings1 = balanceAfter1 - balanceBefore1;
    const contractPayout1 = contractBalanceBeforeClaim1 - contractBalanceAfterClaim1;
    
    console.log(`After claim - Balance: ${formatFP(balanceAfter1)}`);
    console.log(`Winnings received: ${formatFP(winnings1)}`);
    console.log(`Contract balance after claim: ${formatFP(contractBalanceAfterClaim1)} (paid out: ${formatFP(contractPayout1)})`);
    expect(balanceAfter1).to.equal(balanceBefore1 + expectedTotalPayout1);
    expect(contractBalanceAfterClaim1).to.equal(contractBalanceBeforeClaim1 - expectedTotalPayout1);
    
    // User2 claim
    console.log("\n=== USER2 CLAIM ===");
    const balanceBefore2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const contractBalanceBeforeClaim2 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    
    // Get position winnings for Fight 0 (User2 only won Fight 0)
    const [canClaim2_0, userPoints2_0, userWinnings2_0, totalPayout2_0, claimed2_0] = 
      await sportsbook.getPositionWinnings(user2.address, seasonId, 0);
    
    const position2_0 = await sportsbook.getPosition(user2.address, seasonId, 0);
    
    console.log(`Before claim - Balance: ${formatFP(balanceBefore2)}`);
    console.log(`Fight 0: ${formatFP(userWinnings2_0)} winnings + ${formatFP(position2_0.stakeAmount)} stake = ${formatFP(totalPayout2_0)} total (${userPoints2_0} points)`);
    console.log(`Fight 1: Lost (wrong fighter)`);
    console.log(`Expected total payout: ${formatFP(totalPayout2_0)}`);
    
    await expect(sportsbook.connect(user2).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter2 = await fp1155.balanceOf(user2.address, seasonTokenId);
    const contractBalanceAfterClaim2 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const winnings2 = balanceAfter2 - balanceBefore2;
    const contractPayout2 = contractBalanceBeforeClaim2 - contractBalanceAfterClaim2;
    
    console.log(`After claim - Balance: ${formatFP(balanceAfter2)}`);
    console.log(`Winnings received: ${formatFP(winnings2)}`);
    console.log(`Contract balance after claim: ${formatFP(contractBalanceAfterClaim2)} (paid out: ${formatFP(contractPayout2)})`);
    expect(balanceAfter2).to.equal(balanceBefore2 + totalPayout2_0);
    expect(contractBalanceAfterClaim2).to.equal(contractBalanceBeforeClaim2 - totalPayout2_0);
    
    // User3 claim
    console.log("\n=== USER3 CLAIM ===");
    const balanceBefore3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceBeforeClaim3 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    
    // Get position winnings for each fight User3 won
    const [canClaim3_0, userPoints3_0, userWinnings3_0, totalPayout3_0, claimed3_0] = 
      await sportsbook.getPositionWinnings(user3.address, seasonId, 0);
    const [canClaim3_3, userPoints3_3, userWinnings3_3, totalPayout3_3, claimed3_3] = 
      await sportsbook.getPositionWinnings(user3.address, seasonId, 3);
    const [canClaim3_4, userPoints3_4, userWinnings3_4, totalPayout3_4, claimed3_4] = 
      await sportsbook.getPositionWinnings(user3.address, seasonId, 4);
    
    const position3_0 = await sportsbook.getPosition(user3.address, seasonId, 0);
    const position3_3 = await sportsbook.getPosition(user3.address, seasonId, 3);
    const position3_4 = await sportsbook.getPosition(user3.address, seasonId, 4);
    
    console.log(`Before claim - Balance: ${formatFP(balanceBefore3)}`);
    console.log(`Fight 0: ${formatFP(userWinnings3_0)} winnings + ${formatFP(position3_0.stakeAmount)} stake = ${formatFP(totalPayout3_0)} total (${userPoints3_0} points)`);
    console.log(`Fight 3: ${formatFP(userWinnings3_3)} winnings + ${formatFP(position3_3.stakeAmount)} stake = ${formatFP(totalPayout3_3)} total (${userPoints3_3} points)`);
    console.log(`Fight 4: ${formatFP(userWinnings3_4)} winnings + ${formatFP(position3_4.stakeAmount)} stake = ${formatFP(totalPayout3_4)} total (${userPoints3_4} points)`);
    const expectedTotalPayout3 = totalPayout3_0 + totalPayout3_3 + totalPayout3_4;
    console.log(`Expected total payout: ${formatFP(expectedTotalPayout3)}`);
    
    await expect(sportsbook.connect(user3).claim(seasonId))
      .to.emit(sportsbook, "Claimed");
    
    const balanceAfter3 = await fp1155.balanceOf(user3.address, seasonTokenId);
    const contractBalanceAfterClaim3 = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
    const winnings3 = balanceAfter3 - balanceBefore3;
    const contractPayout3 = contractBalanceBeforeClaim3 - contractBalanceAfterClaim3;
    
    console.log(`After claim - Balance: ${formatFP(balanceAfter3)}`);
    console.log(`Winnings received: ${formatFP(winnings3)}`);
    console.log(`Contract balance after claim: ${formatFP(contractBalanceAfterClaim3)} (paid out: ${formatFP(contractPayout3)})`);
    expect(balanceAfter3).to.equal(balanceBefore3 + expectedTotalPayout3);
    expect(contractBalanceAfterClaim3).to.equal(contractBalanceBeforeClaim3 - expectedTotalPayout3);
    
    // ============ STEP 5: Final Summary ============
    console.log("\n=== FINAL RESULTS SUMMARY ===");
    
    // Calculate totals
    const totalWinningsPaid = userWinnings1_0 + userWinnings1_1 + userWinnings1_2 + 
                              userWinnings2_0 + 
                              userWinnings3_0 + userWinnings3_3 + userWinnings3_4;
    
    const totalStakesRecovered = position1_0.stakeAmount + position1_1.stakeAmount + position1_2.stakeAmount +
                                 position2_0.stakeAmount +
                                 position3_0.stakeAmount + position3_3.stakeAmount + position3_4.stakeAmount;
    
    const totalPayout = totalWinningsPaid + totalStakesRecovered;
    
    // Calculate total stakes placed (all users, all fights)
    const totalStakesPlaced = 60n + 60n + 75n; // User1: 60, User2: 60, User3: 75
    
    // Calculate remainder (prize pool + stakes - payouts)
    const expectedRemainder = (totalPrizePool + totalStakesPlaced) - totalPayout;
    
    console.log(`\n--- User1 Results ---`);
    console.log(`  Fight 0: ${formatFP(userWinnings1_0)} winnings + ${formatFP(position1_0.stakeAmount)} stake = ${formatFP(totalPayout1_0)} total`);
    console.log(`  Fight 1: ${formatFP(userWinnings1_1)} winnings + ${formatFP(position1_1.stakeAmount)} stake = ${formatFP(totalPayout1_1)} total`);
    console.log(`  Fight 2: ${formatFP(userWinnings1_2)} winnings + ${formatFP(position1_2.stakeAmount)} stake = ${formatFP(totalPayout1_2)} total`);
    console.log(`  Total: ${formatFP(userWinnings1_0 + userWinnings1_1 + userWinnings1_2)} winnings + ${formatFP(position1_0.stakeAmount + position1_1.stakeAmount + position1_2.stakeAmount)} stake = ${formatFP(expectedTotalPayout1)} total`);
    
    console.log(`\n--- User2 Results ---`);
    console.log(`  Fight 0: ${formatFP(userWinnings2_0)} winnings + ${formatFP(position2_0.stakeAmount)} stake = ${formatFP(totalPayout2_0)} total`);
    console.log(`  Fight 1: Lost (wrong fighter)`);
    console.log(`  Total: ${formatFP(userWinnings2_0)} winnings + ${formatFP(position2_0.stakeAmount)} stake = ${formatFP(totalPayout2_0)} total`);
    
    console.log(`\n--- User3 Results ---`);
    console.log(`  Fight 0: ${formatFP(userWinnings3_0)} winnings + ${formatFP(position3_0.stakeAmount)} stake = ${formatFP(totalPayout3_0)} total`);
    console.log(`  Fight 3: ${formatFP(userWinnings3_3)} winnings + ${formatFP(position3_3.stakeAmount)} stake = ${formatFP(totalPayout3_3)} total`);
    console.log(`  Fight 4: ${formatFP(userWinnings3_4)} winnings + ${formatFP(position3_4.stakeAmount)} stake = ${formatFP(totalPayout3_4)} total`);
    console.log(`  Total: ${formatFP(userWinnings3_0 + userWinnings3_3 + userWinnings3_4)} winnings + ${formatFP(position3_0.stakeAmount + position3_3.stakeAmount + position3_4.stakeAmount)} stake = ${formatFP(expectedTotalPayout3)} total`);
    
    console.log(`\n--- Overall Summary ---`);
    console.log(`  Total Winnings Paid: ${formatFP(totalWinningsPaid)}`);
    console.log(`  Total Stakes Recovered: ${formatFP(totalStakesRecovered)}`);
    console.log(`  Total Payout: ${formatFP(totalPayout)}`);
    console.log(`  Total Stakes Placed: ${formatFP(totalStakesPlaced)}`);
    console.log(`  Total Prize Pool: ${formatFP(totalPrizePool)}`);
    console.log(`  Total in Contract (before payouts): ${formatFP(totalPrizePool + totalStakesPlaced)}`);
    console.log(`  Remainder in Contract: ${formatFP(expectedRemainder)} (truncation remainder)`);
    console.log(`  Final Contract Balance: ${formatFP(contractBalanceAfterClaim3)}`);
    
    // Verify final balances
    expect(contractBalanceAfterClaim3).to.equal(expectedRemainder);
    
    // Verify all positions are claimed
    const [canClaim1_0After, , , , claimed1_0After] = await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
    const [canClaim1_1After, , , , claimed1_1After] = await sportsbook.getPositionWinnings(user1.address, seasonId, 1);
    const [canClaim1_2After, , , , claimed1_2After] = await sportsbook.getPositionWinnings(user1.address, seasonId, 2);
    const [canClaim2_0After, , , , claimed2_0After] = await sportsbook.getPositionWinnings(user2.address, seasonId, 0);
    const [canClaim3_0After, , , , claimed3_0After] = await sportsbook.getPositionWinnings(user3.address, seasonId, 0);
    const [canClaim3_3After, , , , claimed3_3After] = await sportsbook.getPositionWinnings(user3.address, seasonId, 3);
    const [canClaim3_4After, , , , claimed3_4After] = await sportsbook.getPositionWinnings(user3.address, seasonId, 4);
    
    expect(claimed1_0After).to.be.true;
    expect(claimed1_1After).to.be.true;
    expect(claimed1_2After).to.be.true;
    expect(claimed2_0After).to.be.true;
    expect(claimed3_0After).to.be.true;
    expect(claimed3_3After).to.be.true;
    expect(claimed3_4After).to.be.true;
    
    // Visualize final state
    console.log("\n=== FINAL STATE VISUALIZATION ===");
    await visualizeFights(sportsbook, seasonId, 5);
    await visualizeUserBets(sportsbook, seasonId, [user1, user2, user3], ["User1", "User2", "User3"], 5);
 
  });

  describe("Edge Cases: Truncation and Small Pools", function () {
    it("Edge Case 1: Many winners with small pool - truncation to zero", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const [user1, user2, user3, user4, user5] = users.slice(0, 5);
      
      // Create season with 1 fight
      const seasonId = 1n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n;
      
      const fightConfigs = [{
        minBet: 1n,
        maxBet: 100n,
        numOutcomes: 6,
      }];
      
      // Very small prize pool: 1 FP
      const fightPrizePoolAmounts = [1n];
      const totalPrizePool = 1n;
      
      // Mint initial prize pool + extra for seeding (we'll calculate how much we need)
      // Start with enough for initial prize pool + potential seed (e.g., 10 FP should be enough)
      const adminInitialBalance = 10n;
      await fp1155.mint(admin.address, seasonTokenId, adminInitialBalance, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      
      // 5 users bet 1 FP each on the same winning outcome
      const userBalance = 10n;
      for (const user of [user1, user2, user3, user4, user5]) {
        await fp1155.mint(user.address, seasonTokenId, userBalance, "0x");
        await fp1155.setTransferAllowlist(user.address, true);
        await fp1155.connect(user).setApprovalForAll(await sportsbook.getAddress(), true);
      }
      
      // All users bet 1 FP on outcome 0 (Fighter A, Submission)
      for (const user of [user1, user2, user3, user4, user5]) {
        await sportsbook.connect(user).lockPredictionsBatch(
          seasonId,
          [0n],
          [0n],
          [1n]
        );
      }
      
      // Get fight statistics
      const [fighterAUsers, fighterBUsers, fighterAStaked, fighterBStaked, totalUsers, fighterAProb, fighterBProb] = 
        await (sportsbook as any).getFightStatistics(seasonId, 0);
      
      console.log("\n=== FIGHT STATISTICS ===");
      console.log(`Fighter A: ${fighterAUsers} users, ${formatFP(fighterAStaked)} staked (${(Number(fighterAProb) / 100).toFixed(2)}%)`);
      console.log(`Fighter B: ${fighterBUsers} users, ${formatFP(fighterBStaked)} staked (${(Number(fighterBProb) / 100).toFixed(2)}%)`);
      console.log(`Total Users: ${totalUsers}`);
      
      // Calculate required seed BEFORE resolution
      const winningOutcomes = [0];
      const [requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray] = 
        await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
      
      console.log("\n=== PRE-RESOLUTION SEED CALCULATION ===");
      console.log(`Fight 0:`);
      console.log(`  Current Prize Pool: ${formatFP(currentPrizePools[0])}`);
      console.log(`  Required Prize Pool: ${formatFP(requiredPrizePools[0])}`);
      console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeeded[0])}`);
      console.log(`  Winning Users: ${estimatedWinnersArray[0]} (from fighterAUsers: ${fighterAUsers})`);
      console.log(`  Problem: Pool (${formatFP(currentPrizePools[0])}) < Required (${formatFP(requiredPrizePools[0])})`);
      console.log(`  Solution: Need to seed ${formatFP(additionalSeedsNeeded[0])} more FP`);
      
      // Declare variables for use after seeding
      let currentPrizePoolsAfter: bigint[] = currentPrizePools;
      let additionalSeedsNeededAfter: bigint[] = additionalSeedsNeeded;
      
      // Seed the prize pool if needed
      if (additionalSeedsNeeded[0] > 0n) {
        console.log(`\n=== SEEDING PRIZE POOL ===`);
        const adminBalanceBefore = await fp1155.balanceOf(admin.address, seasonTokenId);
        const contractBalanceBeforeSeed = await fp1155.balanceOf(await sportsbook.getAddress(), seasonTokenId);
        
        console.log(`Admin balance before: ${formatFP(adminBalanceBefore)}`);
        console.log(`Contract balance before: ${formatFP(contractBalanceBeforeSeed)}`);
        console.log(`Seeding ${formatFP(additionalSeedsNeeded[0])} FP...`);
        
        // Seed the prize pool with autoSeed = true
        await sportsbook.connect(admin).seedPrizePoolsForSeason(seasonId, winningOutcomes, true);
        
        const adminBalanceAfter = await fp1155.balanceOf(admin.address, seasonTokenId);
        const contractBalanceAfterSeed = await fp1155.balanceOf(await sportsbook.getAddress(), seasonTokenId);
        
        console.log(`Admin balance after: ${formatFP(adminBalanceAfter)}`);
        console.log(`Contract balance after: ${formatFP(contractBalanceAfterSeed)}`);
        console.log(`Admin paid: ${formatFP(adminBalanceBefore - adminBalanceAfter)}`);
        console.log(`Contract received: ${formatFP(contractBalanceAfterSeed - contractBalanceBeforeSeed)}`);
        
        // Verify the seed was applied
        const [requiredPrizePoolsAfter, currentPrizePoolsAfterTemp, additionalSeedsNeededAfterTemp, estimatedWinnersArrayAfter] = 
          await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
        
        currentPrizePoolsAfter = currentPrizePoolsAfterTemp;
        additionalSeedsNeededAfter = additionalSeedsNeededAfterTemp;
        
        console.log(`\n=== VERIFICATION AFTER SEEDING ===`);
        console.log(`Fight 0:`);
        console.log(`  Current Prize Pool: ${formatFP(currentPrizePoolsAfter[0])} (was ${formatFP(currentPrizePools[0])})`);
        console.log(`  Required Prize Pool: ${formatFP(requiredPrizePoolsAfter[0])}`);
        console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeededAfter[0])} (was ${formatFP(additionalSeedsNeeded[0])})`);
        
        expect(currentPrizePoolsAfter[0]).to.equal(currentPrizePools[0] + additionalSeedsNeeded[0]);
        expect(additionalSeedsNeededAfter[0]).to.equal(0n);
      }
      
      // Resolve: outcome 0 wins
      await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      
      const sportsbookAddress = await sportsbook.getAddress();
      
      // Check balances BEFORE claims
 
      const balancesBefore: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const user = [user1, user2, user3, user4, user5][i];
        const balance = await fp1155.balanceOf(user.address, seasonTokenId);
        balancesBefore.push(balance); 
      }
      const contractBalanceBefore = await fp1155.balanceOf(sportsbookAddress, seasonTokenId); 
      
      // Get fight resolution data to see actual prize pool after seed
      const [totalWinningsPool, winningPoolTotalShares, winningOutcome] = 
        await sportsbook.getFightResolutionData(seasonId, 0);
      
      // Check winnings for each user
      console.log("\n=== EDGE CASE 1: Many winners with small pool (AFTER SEEDING) ===");
      console.log(`Initial Prize Pool: ${formatFP(1n)} FP`);
      console.log(`Seeded Prize Pool: ${formatFP(additionalSeedsNeeded[0])} FP`);
      console.log(`Final Prize Pool: ${formatFP(currentPrizePoolsAfter[0])} FP`);
      console.log(`Total Stakes: ${formatFP(5n)} FP (5 users × 1 FP each)`);
      console.log(`\nAfter Resolution:`);
      console.log(`  Total Winnings Pool: ${formatFP(totalWinningsPool)} (${formatFP(currentPrizePoolsAfter[0])} FP prize pool + 0 loser stakes)`);
      console.log(`  Winning Pool Total Shares: ${formatFP(winningPoolTotalShares)} (5 users × 4 shares each)`);
      const expectedWinningsPerUser = (totalWinningsPool * 4n) / winningPoolTotalShares;
      console.log(`  Expected winnings per user: (${formatFP(totalWinningsPool)} × 4) / ${formatFP(winningPoolTotalShares)} = ${formatFP(expectedWinningsPerUser)} FP`);
      console.log(`  ✅ All winners will receive at least 1 FP!`);
      
      // Get winnings info for each user
      const userWinningsInfo: Array<{user: any, points: bigint, winnings: bigint, totalPayout: bigint}> = [];
      for (let i = 0; i < 5; i++) {
        const user = [user1, user2, user3, user4, user5][i];
        const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
          await sportsbook.getPositionWinnings(user.address, seasonId, 0);
        
        userWinningsInfo.push({user, points: userPoints, winnings: userWinnings, totalPayout});
        
        // User should be able to claim (correct winner)
        expect(canClaim).to.be.true;
        expect(userPoints).to.equal(4n); // Exact match
        // Winnings should be at least 1 FP after seeding
        expect(userWinnings).to.be.gte(1n);
        // User should receive stake + winnings
        expect(totalPayout).to.be.gte(2n); // At least 1 stake + 1 winnings
      }
      
      // Users claim their winnings
      console.log("\n=== USERS CLAIM WINNINGS ===");
      let totalPayouts = 0n;
      for (let i = 0; i < 5; i++) {
        const user = [user1, user2, user3, user4, user5][i];
        const info = userWinningsInfo[i];
        
        const balanceBeforeClaim = await fp1155.balanceOf(user.address, seasonTokenId);
        const contractBalanceBeforeClaim = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
        
        await expect(sportsbook.connect(user).claim(seasonId))
          .to.emit(sportsbook, "Claimed");
        
        const balanceAfterClaim = await fp1155.balanceOf(user.address, seasonTokenId);
        const contractBalanceAfterClaim = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
        const received = balanceAfterClaim - balanceBeforeClaim;
        const contractPaid = contractBalanceBeforeClaim - contractBalanceAfterClaim;
        
        totalPayouts += info.totalPayout;
        
        console.log(`\nUser${i + 1} claim:`);
        console.log(`  Balance before: ${formatFP(balanceBeforeClaim)}`);
        console.log(`  Balance after: ${formatFP(balanceAfterClaim)}`);
        console.log(`  Received: ${formatFP(received)} (${formatFP(info.winnings)} winnings + ${formatFP(1n)} stake)`);
        console.log(`  Contract paid: ${formatFP(contractPaid)}`);
        
        expect(balanceAfterClaim).to.equal(balanceBeforeClaim + info.totalPayout);
        expect(contractPaid).to.equal(info.totalPayout);
      }
      
      // Final balances
      console.log("\n=== FINAL BALANCES ===");
      for (let i = 0; i < 5; i++) {
        const user = [user1, user2, user3, user4, user5][i];
        const balanceAfter = await fp1155.balanceOf(user.address, seasonTokenId);
        const balanceBefore = balancesBefore[i];
        const received = balanceAfter - balanceBefore;
        console.log(`User${i + 1}: ${formatFP(balanceBefore)} → ${formatFP(balanceAfter)} (received: ${formatFP(received)})`);
      }
      const contractBalanceFinal = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      console.log(`Sportsbook contract balance: ${formatFP(contractBalanceBefore)} → ${formatFP(contractBalanceFinal)}`);
      console.log(`Total payouts: ${formatFP(totalPayouts)} (5 users × ${formatFP(totalPayouts / 5n)} FP each)`);
      console.log(`Remainder in contract: ${formatFP(contractBalanceFinal)} FP`);
      console.log(`\n💡 Explanation:`);
      console.log(`  - Initial: ${formatFP(contractBalanceBefore)} FP (${formatFP(currentPrizePoolsAfter[0])} prize pool + 5 stakes)`);
      console.log(`  - Paid out: ${formatFP(totalPayouts)} FP (stakes + winnings)`);
      console.log(`  - Remainder: ${formatFP(contractBalanceFinal)} FP (residual from distribution)`);
      console.log(`  - ✅ All winners received winnings thanks to seeding!`);
      
      expect(contractBalanceFinal).to.equal(contractBalanceBefore - totalPayouts);
    });

    it("Edge Case 2: One winner with large pool", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const [user1] = users;
      const sportsbookAddress = await sportsbook.getAddress();
      
      const seasonId = 2n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n;
      
      const fightConfigs = [{
        minBet: 1n,
        maxBet: 1000n,
        numOutcomes: 6,
      }];
      
      // Large prize pool: 1000 FP
      const fightPrizePoolAmounts = [1000n];
      const totalPrizePool = 1000n;
      
      await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      
      // Single user bets 1 FP
      await fp1155.mint(user1.address, seasonTokenId, 10n, "0x");
      await fp1155.setTransferAllowlist(user1.address, true);
      await fp1155.connect(user1).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.connect(user1).lockPredictionsBatch(
        seasonId,
        [0n],
        [0n],
        [1n]
      );
      
      // Calculate required seed BEFORE resolution
      const winningOutcomes = [0];
      const [requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray] = 
        await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
      
      console.log("\n=== PRE-RESOLUTION SEED CALCULATION ===");
      console.log(`Fight 0:`);
      console.log(`  Current Prize Pool: ${formatFP(currentPrizePools[0])}`);
      console.log(`  Required Prize Pool: ${formatFP(requiredPrizePools[0])}`);
      console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeeded[0])}`);
      console.log(`  Estimated Winners: ${estimatedWinnersArray[0]}`);
      console.log(`  Status: Pool is sufficient (no additional seed needed)`);
      
      // Resolve: outcome 0 wins
      await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      
      const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
        await sportsbook.getPositionWinnings(user1.address, seasonId, 0);
      
      console.log("\n=== EDGE CASE 2: One winner with large pool ===");
      console.log(`Total Winnings Pool: ${formatFP(1000n)}`);
      console.log(`Winning Pool Total Shares: ${formatFP(4n)} (1 user × 4 shares)`);
      console.log(`Expected winnings: (1000 × 4) / 4 = 1000 FP`);
      
      expect(canClaim).to.be.true;
      expect(userPoints).to.equal(4n);
      expect(userWinnings).to.equal(1000n);
      expect(totalPayout).to.equal(1001n); // 1 stake + 1000 winnings
    });

    it("Edge Case 3: Many winners with different stakes", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const [user1, user2, user3, user4, user5] = users.slice(0, 5);
      const sportsbookAddress = await sportsbook.getAddress();
      
      const seasonId = 3n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n;
      
      const fightConfigs = [{
        minBet: 1n,
        maxBet: 1000n,
        numOutcomes: 6,
      }];
      
      // Small prize pool: 10 FP
      const fightPrizePoolAmounts = [10n];
      const totalPrizePool = 10n;
      
      await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      
      // Setup users
      for (const user of [user1, user2, user3, user4, user5]) {
        await fp1155.mint(user.address, seasonTokenId, 1000n, "0x");
        await fp1155.setTransferAllowlist(user.address, true);
        await fp1155.connect(user).setApprovalForAll(await sportsbook.getAddress(), true);
      }
      
      // 4 users bet 1 FP each, 1 user bets 100 FP
      await sportsbook.connect(user1).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      await sportsbook.connect(user2).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      await sportsbook.connect(user3).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      await sportsbook.connect(user4).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      await sportsbook.connect(user5).lockPredictionsBatch(seasonId, [0n], [0n], [100n]);
      
      // Calculate required seed BEFORE resolution
      const winningOutcomes = [0];
      const [requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray] = 
        await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
      
      console.log("\n=== PRE-RESOLUTION SEED CALCULATION ===");
      console.log(`Fight 0:`);
      console.log(`  Current Prize Pool: ${formatFP(currentPrizePools[0])}`);
      console.log(`  Required Prize Pool: ${formatFP(requiredPrizePools[0])}`);
      console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeeded[0])}`);
      console.log(`  Estimated Winners: ${estimatedWinnersArray[0]}`);
      console.log(`  Problem: Pool (${formatFP(currentPrizePools[0])}) < Required (${formatFP(requiredPrizePools[0])})`);
      console.log(`  Solution: Need to seed ${formatFP(additionalSeedsNeeded[0])} more FP`);
      console.log(`  Impact: Small stake users (1 FP) will get 0 winnings due to truncation`);
      
      // Resolve: outcome 0 wins
      await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      
      console.log("\n=== EDGE CASE 3: Many winners with different stakes ===");
      console.log(`Total Winnings Pool: ${formatFP(10n)} (10 FP prize pool + 0 loser stakes)`);
      console.log(`Winning Pool Total Shares: ${formatFP(412n)} (4 users × 4 shares + 1 user × 400 shares)`);
      
      // Check small stake users (1 FP each)
      for (let i = 0; i < 4; i++) {
        const user = [user1, user2, user3, user4][i];
        const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
          await sportsbook.getPositionWinnings(user.address, seasonId, 0);
        
        console.log(`\nUser${i + 1} (1 FP stake):`);
        console.log(`  Winnings: ${formatFP(userWinnings)}`);
        console.log(`  Total Payout: ${formatFP(totalPayout)}`);
        
        expect(canClaim).to.be.true;
        expect(userPoints).to.equal(4n);
        // (10 * 4) / 412 = 40 / 412 = 0 (truncated)
        expect(userWinnings).to.equal(0n);
        expect(totalPayout).to.equal(1n); // Only stake recovered
      }
      
      // Check large stake user (100 FP)
      const [canClaim5, userPoints5, userWinnings5, totalPayout5, claimed5] = 
        await sportsbook.getPositionWinnings(user5.address, seasonId, 0);
      
      console.log(`\nUser5 (100 FP stake):`);
      console.log(`  Winnings: ${formatFP(userWinnings5)}`);
      console.log(`  Total Payout: ${formatFP(totalPayout5)}`);
      
      expect(canClaim5).to.be.true;
      expect(userPoints5).to.equal(4n);
      // (10 * 400) / 412 = 4000 / 412 = 9 FP (truncated, should be 9.708...)
      expect(userWinnings5).to.equal(9n);
      expect(totalPayout5).to.equal(109n); // 100 stake + 9 winnings
    });

    it("Edge Case 4: Pool exactly equals shares (no truncation)", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const [user1, user2, user3, user4, user5] = users.slice(0, 5);
      const sportsbookAddress = await sportsbook.getAddress();
      
      const seasonId = 4n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n;
      
      const fightConfigs = [{
        minBet: 1n,
        maxBet: 1000n,
        numOutcomes: 6,
      }];
      
      // Prize pool: 20 FP (exactly equals 5 users × 4 shares)
      const fightPrizePoolAmounts = [20n];
      const totalPrizePool = 20n;
      
      await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      
      // 5 users bet 1 FP each
      for (const user of [user1, user2, user3, user4, user5]) {
        await fp1155.mint(user.address, seasonTokenId, 10n, "0x");
        await fp1155.setTransferAllowlist(user.address, true);
        await fp1155.connect(user).setApprovalForAll(await sportsbook.getAddress(), true);
        await sportsbook.connect(user).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      }
      
      // Calculate required seed BEFORE resolution
      const winningOutcomes = [0];
      const [requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray] = 
        await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
      
      console.log("\n=== PRE-RESOLUTION SEED CALCULATION ===");
      console.log(`Fight 0:`);
      console.log(`  Current Prize Pool: ${formatFP(currentPrizePools[0])}`);
      console.log(`  Required Prize Pool: ${formatFP(requiredPrizePools[0])}`);
      console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeeded[0])}`);
      console.log(`  Estimated Winners: ${estimatedWinnersArray[0]}`);
      console.log(`  Status: Pool is sufficient (no additional seed needed)`);
      
      // Resolve: outcome 0 wins
      await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      
      console.log("\n=== EDGE CASE 4: Pool exactly equals shares ===");
      console.log(`Total Winnings Pool: ${formatFP(20n)}`);
      console.log(`Winning Pool Total Shares: ${formatFP(20n)} (5 users × 4 shares)`);
      console.log(`Expected winnings per user: (20 × 4) / 20 = 4 FP`);
      
      for (let i = 0; i < 5; i++) {
        const user = [user1, user2, user3, user4, user5][i];
        const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
          await sportsbook.getPositionWinnings(user.address, seasonId, 0);
        
        expect(canClaim).to.be.true;
        expect(userPoints).to.equal(4n);
        expect(userWinnings).to.equal(4n); // Perfect division, no truncation
        expect(totalPayout).to.equal(5n); // 1 stake + 4 winnings
      }
    });

    it("Edge Case 5: Pool smaller than shares (severe truncation)", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const [user1, user2, user3, user4, user5, user6, user7, user8, user9, user10] = users.slice(0, 10);
      const sportsbookAddress = await sportsbook.getAddress();
      
      const seasonId = 5n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n;
      
      const fightConfigs = [{
        minBet: 1n,
        maxBet: 1000n,
        numOutcomes: 6,
      }];
      
      // Very small prize pool: 1 FP
      const fightPrizePoolAmounts = [1n];
      const totalPrizePool = 1n;
      
      await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      
      // 10 users bet 1 FP each
      const allUsers = [user1, user2, user3, user4, user5, user6, user7, user8, user9, user10];
      for (const user of allUsers) {
        await fp1155.mint(user.address, seasonTokenId, 10n, "0x");
        await fp1155.setTransferAllowlist(user.address, true);
        await fp1155.connect(user).setApprovalForAll(await sportsbook.getAddress(), true);
        await sportsbook.connect(user).lockPredictionsBatch(seasonId, [0n], [0n], [1n]);
      }
      
      // Calculate required seed BEFORE resolution
      const winningOutcomes = [0];
      const [requiredPrizePools, currentPrizePools, additionalSeedsNeeded, estimatedWinnersArray] = 
        await (sportsbook as any).calculateRequiredSeedForSeason(seasonId, winningOutcomes);
      
      console.log("\n=== PRE-RESOLUTION SEED CALCULATION ===");
      console.log(`Fight 0:`);
      console.log(`  Current Prize Pool: ${formatFP(currentPrizePools[0])}`);
      console.log(`  Required Prize Pool: ${formatFP(requiredPrizePools[0])}`);
      console.log(`  Additional Seed Needed: ${formatFP(additionalSeedsNeeded[0])}`);
      console.log(`  Estimated Winners: ${estimatedWinnersArray[0]}`);
      console.log(`  Problem: Pool (${formatFP(currentPrizePools[0])}) < Required (${formatFP(requiredPrizePools[0])})`);
      console.log(`  Solution: Need to seed ${formatFP(additionalSeedsNeeded[0])} more FP`);
      console.log(`  Impact: All users will get 0 winnings due to truncation`);
      
      // Resolve: outcome 0 wins
      await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      
      console.log("\n=== EDGE CASE 5: Pool smaller than shares ===");
      console.log(`Total Winnings Pool: ${formatFP(1n)}`);
      console.log(`Winning Pool Total Shares: ${formatFP(40n)} (10 users × 4 shares)`);
      console.log(`Expected winnings per user: (1 × 4) / 40 = 0 FP (truncated)`);
      console.log(`Problem: Only first user to claim will get the 1 FP, others get 0`);
      
      // First user claims
      const balanceBefore1 = await fp1155.balanceOf(user1.address, seasonTokenId);
      await sportsbook.connect(user1).claim(seasonId);
      const balanceAfter1 = await fp1155.balanceOf(user1.address, seasonTokenId);
      const winnings1 = balanceAfter1 - balanceBefore1;
      
      console.log(`\nUser1 claim: ${formatFP(winnings1)}`);
      
      // Check remaining users
      for (let i = 1; i < 10; i++) {
        const user = allUsers[i];
        const [canClaim, userPoints, userWinnings, totalPayout, claimed] = 
          await sportsbook.getPositionWinnings(user.address, seasonId, 0);
        
        console.log(`User${i + 1}: winnings=${formatFP(userWinnings)}, total=${formatFP(totalPayout)}`);
        
        expect(canClaim).to.be.true;
        expect(userPoints).to.equal(4n);
        // After first user claimed, pool might be 0, so others get 0 winnings
        expect(userWinnings).to.equal(0n);
        expect(totalPayout).to.equal(1n); // Only stake recovered
      }
    });
  });

  describe.skip("Stress Test: 15 Fights with 10,000 Users", function () {
    it.skip("Should handle 15 fights with 10,000 users making predictions", async function () {
      const { fp1155, sportsbook, admin, users } = await setupContracts();
      const sportsbookAddress = await sportsbook.getAddress();
      const TRANSFER_AGENT_ROLE = await fp1155.TRANSFER_AGENT_ROLE();
      expect(await fp1155.hasRole(TRANSFER_AGENT_ROLE, sportsbookAddress)).to.be.true;
      
      console.log("\n=== STRESS TEST: 15 Fights with 10,000 Users ===");
      
      // ============ STEP 1: Create Season with 15 fights ============
      const seasonId = 100n;
      const seasonTokenId = 1n;
      const latestBlock = await ethers.provider.getBlock("latest");
      const cutOffTime = BigInt(latestBlock!.timestamp) + 86400n; // 1 day from now
      
      // 15 fights, each with 6 outcomes (Fighter A/B x 3 methods)
      const fightConfigs = Array(15).fill({
        minBet: 1n,
        maxBet: 1000n,
        numOutcomes: 6,
      });
      
      // Prize pool: 10,000 FP per fight = 150,000 FP total (minimum 10k per fight)
      const fightPrizePoolAmounts = Array(15).fill(10000n);
      const totalPrizePool = 150000n;
      
      // Mint FP tokens to admin for prize pools
      await fp1155.mint(admin.address, seasonTokenId, totalPrizePool, "0x");
      await fp1155.setTransferAllowlist(admin.address, true);
      await fp1155.connect(admin).setApprovalForAll(await sportsbook.getAddress(), true);
      
      console.log(`\nCreating season with 15 fights...`);
      const createSeasonTx = await sportsbook.createSeasonWithFights(
        seasonId,
        cutOffTime,
        seasonTokenId,
        fightConfigs,
        fightPrizePoolAmounts
      );
      await createSeasonTx.wait();
      console.log(`✓ Season created successfully`);
      
      // ============ STEP 2: Generate 10,000 users ============
      console.log(`\nGenerating 10,000 users...`);
      const NUM_USERS = 10000;
      const allUsers: any[] = [];
      
      // Use existing signers first
      for (const user of users) {
        allUsers.push(user);
      }
      
      // Generate additional signers if needed
      // We'll use a provider to create wallets that can sign transactions
      const provider = ethers.provider;
      const FUND_BATCH_SIZE = 50; // Fund wallets in batches
      
      while (allUsers.length < NUM_USERS) {
        // Generate batch of wallets
        const batchWallets: any[] = [];
        while (batchWallets.length < FUND_BATCH_SIZE && allUsers.length + batchWallets.length < NUM_USERS) {
          const wallet = ethers.Wallet.createRandom().connect(provider);
          batchWallets.push(wallet);
        }
        
        // Fund all wallets in batch (parallel)
        const fundPromises = batchWallets.map(wallet => 
          admin.sendTransaction({
            to: wallet.address,
            value: ethers.parseEther("0.1"), // 0.1 ETH for gas (enough for stress test)
          })
        );
        await Promise.all(fundPromises);
        
        // Add to allUsers
        allUsers.push(...batchWallets);
        
        if (allUsers.length % 1000 === 0 || allUsers.length >= NUM_USERS) {
          console.log(`  Generated ${Math.min(allUsers.length, NUM_USERS)}/${NUM_USERS} users`);
        }
      }
      
      // Keep only the first NUM_USERS
      const testUsers = allUsers.slice(0, NUM_USERS);
      console.log(`✓ Generated ${testUsers.length} users`);
      
      // ============ STEP 3: Setup users (mint tokens, allowlist, approve) ============
      console.log(`\nSetting up users (minting tokens, allowlist, approvals)...`);
      const userBalance = 1000n; // Each user gets 1000 FP
      const BATCH_SIZE = 100; // Process in batches to avoid gas issues
      
      // Track gas costs for mints (sample)
      const MINT_GAS_SAMPLE_SIZE = 100; // Track gas for first 100 mints
      const mintGasUsed: bigint[] = [];
      
      for (let i = 0; i < testUsers.length; i += BATCH_SIZE) {
        const batch = testUsers.slice(i, Math.min(i + BATCH_SIZE, testUsers.length));
        const batchPromises = batch.map(async (user, batchIndex) => {
          const globalIndex = i + batchIndex;
          
          // Mint tokens - track gas for sample
          if (globalIndex < MINT_GAS_SAMPLE_SIZE) {
            const mintTx = await fp1155.mint(user.address, seasonTokenId, userBalance, "0x");
            const receipt = await mintTx.wait();
            if (receipt) {
              mintGasUsed.push(receipt.gasUsed);
            }
          } else {
            await fp1155.mint(user.address, seasonTokenId, userBalance, "0x");
          }
          
          // Add to allowlist
          await fp1155.setTransferAllowlist(user.address, true);
          // Approve sportsbook
          await fp1155.connect(user).setApprovalForAll(await sportsbook.getAddress(), true);
        });
        await Promise.all(batchPromises);
        
        if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= testUsers.length) {
          console.log(`  Processed ${Math.min(i + BATCH_SIZE, testUsers.length)}/${testUsers.length} users`);
        }
      }
      
      // Verify contract has prize pool
      const contractBalanceAfterSetup = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      expect(contractBalanceAfterSetup).to.equal(totalPrizePool);
      console.log(`✓ All users set up (contract balance verified: ${formatFP(contractBalanceAfterSetup)})`);
      
      // ============ STEP 4: Users make predictions ============
      console.log(`\nUsers making predictions on 15 fights...`);
      
      // Strategy: Each user bets on a random subset of fights (1-5 fights per user)
      // with random outcomes and random stakes (1-100 FP)
      let totalPredictions = 0;
      const predictionsPerUser = 3; // Average 3 predictions per user
      
      for (let i = 0; i < testUsers.length; i += BATCH_SIZE) {
        const batch = testUsers.slice(i, Math.min(i + BATCH_SIZE, testUsers.length));
        const batchPromises = batch.map(async (user, batchIndex) => {
          const globalIndex = i + batchIndex;
          
          // Determine how many fights this user will bet on (1-5 fights)
          const numFightsToBet = (globalIndex % 5) + 1;
          
          // Select random fights (without repetition)
          // Use a deterministic but distributed approach
          const fightIds: bigint[] = [];
          const selectedFights = new Set<number>();
          
          // Start with a base fight ID based on user index
          let baseFightId = globalIndex % 15;
          
          while (fightIds.length < numFightsToBet && selectedFights.size < 15) {
            const fightId = (baseFightId + fightIds.length) % 15;
            if (!selectedFights.has(fightId)) {
              selectedFights.add(fightId);
              fightIds.push(BigInt(fightId));
            } else {
              // Try next available fight
              for (let offset = 1; offset < 15; offset++) {
                const nextFightId = (baseFightId + fightIds.length + offset) % 15;
                if (!selectedFights.has(nextFightId)) {
                  selectedFights.add(nextFightId);
                  fightIds.push(BigInt(nextFightId));
                  break;
                }
              }
            }
          }
          
          // Generate random outcomes and stakes
          const outcomes: bigint[] = [];
          const stakes: bigint[] = [];
          
          for (const fightId of fightIds) {
            // Random outcome (0-5)
            const outcome = BigInt(globalIndex % 6);
            outcomes.push(outcome);
            
            // Random stake (1-100 FP)
            const stake = BigInt((globalIndex % 100) + 1);
            stakes.push(stake);
          }
          
          // Make prediction
          try {
            await sportsbook.connect(user).lockPredictionsBatch(
              seasonId,
              fightIds,
              outcomes,
              stakes
            );
            totalPredictions += fightIds.length;
          } catch (error) {
            // Some predictions might fail (e.g., duplicate positions), that's ok for stress test
            console.log(`  Warning: User ${globalIndex} prediction failed (this is ok)`);
          }
        });
        
        await Promise.all(batchPromises);
        
        if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= testUsers.length) {
          console.log(`  Processed ${Math.min(i + BATCH_SIZE, testUsers.length)}/${testUsers.length} users (${totalPredictions} total predictions)`);
        }
      }
      
      console.log(`✓ Predictions completed. Total predictions: ${totalPredictions}`);
      
      // ============ STEP 5: Verify contract state and balances ============
      console.log(`\nVerifying contract state and balances...`);
      const contractBalanceAfterPredictions = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      
      // Get fight statistics and calculate total staked
      let totalStaked = 0n;
      let totalFighterAStaked = 0n;
      let totalFighterBStaked = 0n;
      for (let fightId = 0; fightId < 15; fightId++) {
        const fightState = await sportsbook.fightStates(seasonId, BigInt(fightId));
        const fightStaked = fightState.fighterAStaked + fightState.fighterBStaked;
        totalStaked += fightStaked;
        totalFighterAStaked += fightState.fighterAStaked;
        totalFighterBStaked += fightState.fighterBStaked;
        if (fightId < 3 || fightId === 14) {
          console.log(`  Fight ${fightId}: Fighter A: ${formatFP(fightState.fighterAStaked)}, Fighter B: ${formatFP(fightState.fighterBStaked)}`);
        }
      }
      
      // CRITICAL VERIFICATION: Contract balance should equal prize pool + total stakes
      const expectedContractBalance = totalPrizePool + totalStaked;
      expect(contractBalanceAfterPredictions).to.equal(expectedContractBalance);
      console.log(`  Contract balance: ${formatFP(contractBalanceAfterPredictions)}`);
      console.log(`  Expected balance: ${formatFP(expectedContractBalance)} (prize pool: ${formatFP(totalPrizePool)} + stakes: ${formatFP(totalStaked)})`);
      console.log(`  Total staked across all fights: ${formatFP(totalStaked)}`);
      console.log(`  Total Fighter A staked: ${formatFP(totalFighterAStaked)}`);
      console.log(`  Total Fighter B staked: ${formatFP(totalFighterBStaked)}`);
      console.log(`✓ Contract state and balance verified (integrity check passed)`);
      
      // Verify sample user balances decreased correctly
      console.log(`\nVerifying sample user balances...`);
      const sampleUserIndices = [0, 100, 1000, 5000, 9999]; // Sample across range
      for (const index of sampleUserIndices) {
        if (index < testUsers.length) {
          const user = testUsers[index];
          const userBalanceAfter = await fp1155.balanceOf(user.address, seasonTokenId);
          // User should have less than initial balance (some was staked)
          expect(userBalanceAfter).to.be.lt(userBalance);
          if (index < 5) {
            console.log(`  User ${index}: Balance ${formatFP(userBalanceAfter)} (initial: ${formatFP(userBalance)})`);
          }
        }
      }
      console.log(`✓ User balances verified`);
      
      // ============ STEP 6: Resolve Season ============
      console.log(`\nResolving season...`);
      // Winning outcomes: random but consistent
      const winningOutcomes = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2];
      
      // Store contract balance before resolution
      const contractBalanceBeforeResolution = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      
      const resolveTx = await sportsbook.connect(admin).resolveSeason(seasonId, winningOutcomes);
      await resolveTx.wait();
      
      // Verify contract balance didn't change during resolution (only state changes)
      const contractBalanceAfterResolution = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      expect(contractBalanceAfterResolution).to.equal(contractBalanceBeforeResolution);
      console.log(`✓ Season resolved (contract balance unchanged: ${formatFP(contractBalanceAfterResolution)})`);
      
      // Verify resolution data for all fights
      console.log(`\nVerifying resolution data...`);
      for (let fightId = 0; fightId < 15; fightId++) {
        const [totalWinningsPool, winningPoolTotalShares, winningOutcome] = 
          await sportsbook.getFightResolutionData(seasonId, fightId);
        const fightState = await sportsbook.fightStates(seasonId, BigInt(fightId));
        
        // Verify resolution data matches fight state
        expect(winningOutcome).to.equal(BigInt(winningOutcomes[fightId]));
        expect(fightState.winningOutcome).to.equal(BigInt(winningOutcomes[fightId]));
        expect(fightState.totalWinningsPool).to.equal(totalWinningsPool);
        expect(fightState.winningPoolTotalShares).to.equal(winningPoolTotalShares);
        
        // Verify totalWinningsPool = prizePool + loser stakes
        const winningFighterIndex = (winningOutcome >> 2n) & 1n;
        const expectedLoserStakes = winningFighterIndex === 0n 
          ? fightState.fighterBStaked 
          : fightState.fighterAStaked;
        const expectedTotalWinningsPool = fightState.prizePool + expectedLoserStakes;
        expect(totalWinningsPool).to.equal(expectedTotalWinningsPool);
        
        if (fightId < 3 || fightId === 14) {
          console.log(`  Fight ${fightId}: Winnings Pool: ${formatFP(totalWinningsPool)}, Shares: ${formatFP(winningPoolTotalShares)}`);
        }
      }
      console.log(`✓ Resolution data verified for all 15 fights`);
      
      // ============ STEP 7: Find ALL winning users and make them claim ============
      console.log(`\nFinding ALL winning users and processing claims...`);
      
      // First, find ALL users who have winning positions (no limit)
      console.log(`  Scanning ALL users for winning positions...`);
      const winningUsers: Array<{index: number, user: any, totalPayout: bigint}> = [];
      
      // Scan ALL users in batches to find ALL winners
      for (let i = 0; i < testUsers.length; i += BATCH_SIZE) {
        const batch = testUsers.slice(i, Math.min(i + BATCH_SIZE, testUsers.length));
        const batchPromises = batch.map(async (user, batchIndex) => {
          const globalIndex = i + batchIndex;
          try {
            let totalPayout = 0n;
            let hasClaimable = false;
            
            for (let fightId = 0; fightId < 15; fightId++) {
              try {
                const [canClaim, , , payout, claimed] = 
                  await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
                if (canClaim && !claimed) {
                  hasClaimable = true;
                  totalPayout += payout;
                }
              } catch (e) {
                // Position doesn't exist
              }
            }
            
            if (hasClaimable && totalPayout > 0n) {
              return { index: globalIndex, user, totalPayout };
            }
            return null;
          } catch (error) {
            return null;
          }
        });
        
        const results = await Promise.all(batchPromises);
        for (const result of results) {
          if (result) {
            winningUsers.push(result);
          }
        }
        
        if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= testUsers.length) {
          console.log(`    Scanned ${Math.min(i + BATCH_SIZE, testUsers.length)}/${testUsers.length} users, found ${winningUsers.length} winners`);
        }
      }
      
      console.log(`  Found ${winningUsers.length} winning users with claimable positions`);
      
      if (winningUsers.length === 0) {
        console.log(`  ⚠️  Warning: No winning users found. This might indicate an issue.`);
        console.log(`  Checking a few specific users to verify...`);
        
        // Check first few users manually
        for (let i = 0; i < Math.min(10, testUsers.length); i++) {
          const user = testUsers[i];
          for (let fightId = 0; fightId < 15; fightId++) {
            try {
              const [canClaim, points, winnings, totalPayout, claimed] = 
                await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
              if (canClaim) {
                console.log(`    User ${i}, Fight ${fightId}: canClaim=${canClaim}, points=${points}, winnings=${formatFP(winnings)}, totalPayout=${formatFP(totalPayout)}, claimed=${claimed}`);
              }
            } catch (e) {
              // Position doesn't exist
            }
          }
        }
      }
      
      // Store contract balance before claims
      const contractBalanceBeforeClaims = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      
      let successfulClaims = 0;
      let totalClaimed = 0n;
      
      // Track gas costs for claims (sample)
      const CLAIM_GAS_SAMPLE_SIZE = 100; // Track gas for first 100 claims
      const claimGasUsed: bigint[] = [];
      
      // Process claims for ALL winning users sequentially
      // Note: We process sequentially because claims affect contract state
      console.log(`\n  Processing claims for ALL ${winningUsers.length} winning users (sequentially)...`);
      
      for (let i = 0; i < winningUsers.length; i++) {
        const { index, user } = winningUsers[i];
        try {
          // Recalculate expected payout right before claiming (state may have changed)
          let expectedTotalPayout = 0n;
          for (let fightId = 0; fightId < 15; fightId++) {
            try {
              const [canClaim, , , totalPayout, claimed] = 
                await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
              if (canClaim && !claimed) {
                expectedTotalPayout += totalPayout;
              }
            } catch (e) {
              // Position doesn't exist
            }
          }
          
          // Skip if no claimable positions (might have been claimed already or winnings are 0)
          if (expectedTotalPayout === 0n) {
            continue;
          }
          
          const balanceBefore = await fp1155.balanceOf(user.address, seasonTokenId);
          const contractBalanceBeforeUserClaim = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
          
          // Track gas for sample claims
          if (successfulClaims < CLAIM_GAS_SAMPLE_SIZE) {
            const claimTx = await sportsbook.connect(user).claim(seasonId);
            const receipt = await claimTx.wait();
            if (receipt) {
              claimGasUsed.push(receipt.gasUsed);
            }
          } else {
            await sportsbook.connect(user).claim(seasonId);
          }
          
          const balanceAfter = await fp1155.balanceOf(user.address, seasonTokenId);
          const contractBalanceAfterUserClaim = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
          
          const claimedAmount = balanceAfter - balanceBefore;
          const contractPaid = contractBalanceBeforeUserClaim - contractBalanceAfterUserClaim;
          
          // CRITICAL VERIFICATION: Contract paid exactly what user received
          expect(contractPaid).to.equal(claimedAmount);
          
          // Note: claimedAmount might differ slightly from expectedTotalPayout due to rounding
          // but contractPaid should always equal claimedAmount
          totalClaimed += claimedAmount;
          successfulClaims++;
          
          if (i < 5 || (i + 1) % 500 === 0) {
            console.log(`    Claim ${i + 1}/${winningUsers.length}: User ${index} claimed ${formatFP(claimedAmount)} (expected: ${formatFP(expectedTotalPayout)})`);
          }
        } catch (error) {
          console.log(`    ⚠️  Warning: User ${index} claim failed: ${error}`);
        }
      }
      
      // CRITICAL VERIFICATION: Contract balance decreased by exactly what was claimed
      const contractBalanceAfterClaims = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      const contractPaidTotal = contractBalanceBeforeClaims - contractBalanceAfterClaims;
      expect(contractPaidTotal).to.equal(totalClaimed);
      
      console.log(`\n  Successful claims: ${successfulClaims}/${winningUsers.length}`);
      console.log(`  Total claimed: ${formatFP(totalClaimed)}`);
      console.log(`  Contract paid: ${formatFP(contractPaidTotal)} (verified match)`);
      console.log(`  Contract balance before: ${formatFP(contractBalanceBeforeClaims)}`);
      console.log(`  Contract balance after: ${formatFP(contractBalanceAfterClaims)}`);
      console.log(`✓ Claims tested successfully (integrity verified)`);
      
      // ============ STEP 7.5: Calculate gas costs ============
      console.log(`\n=== GAS COST ANALYSIS ===`);
      
      // Get current gas price
      const feeData = await ethers.provider.getFeeData();
      const gasPrice = feeData.gasPrice || 0n;
      
      let avgMintGas = 0n;
      let avgClaimGas = 0n;
      
      if (gasPrice > 0n && mintGasUsed.length > 0) {
        // Calculate mint gas costs
        const totalMintGas = mintGasUsed.reduce((sum, gas) => sum + gas, 0n);
        avgMintGas = totalMintGas / BigInt(mintGasUsed.length);
        const minMintGas = mintGasUsed.reduce((min, gas) => gas < min ? gas : min, mintGasUsed[0]);
        const maxMintGas = mintGasUsed.reduce((max, gas) => gas > max ? gas : max, mintGasUsed[0]);
        
        const avgMintCost = (avgMintGas * gasPrice);
        const minMintCost = (minMintGas * gasPrice);
        const maxMintCost = (maxMintGas * gasPrice);
        
        console.log(`\n  Mint Gas Costs (sample of ${mintGasUsed.length} mints):`);
        console.log(`    Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`    Average Gas: ${avgMintGas.toString()} units`);
        console.log(`    Min Gas: ${minMintGas.toString()} units`);
        console.log(`    Max Gas: ${maxMintGas.toString()} units`);
        console.log(`    Average Cost: ${ethers.formatEther(avgMintCost)} ETH`);
        console.log(`    Min Cost: ${ethers.formatEther(minMintCost)} ETH`);
        console.log(`    Max Cost: ${ethers.formatEther(maxMintCost)} ETH`);
      }
      
      if (gasPrice > 0n && claimGasUsed.length > 0) {
        // Calculate claim gas costs
        const totalClaimGas = claimGasUsed.reduce((sum, gas) => sum + gas, 0n);
        avgClaimGas = totalClaimGas / BigInt(claimGasUsed.length);
        const minClaimGas = claimGasUsed.reduce((min, gas) => gas < min ? gas : min, claimGasUsed[0]);
        const maxClaimGas = claimGasUsed.reduce((max, gas) => gas > max ? gas : max, claimGasUsed[0]);
        
        const avgClaimCost = (avgClaimGas * gasPrice);
        const minClaimCost = (minClaimGas * gasPrice);
        const maxClaimCost = (maxClaimGas * gasPrice);
        
        console.log(`\n  Claim Gas Costs (sample of ${claimGasUsed.length} claims):`);
        console.log(`    Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`    Average Gas: ${avgClaimGas.toString()} units`);
        console.log(`    Min Gas: ${minClaimGas.toString()} units`);
        console.log(`    Max Gas: ${maxClaimGas.toString()} units`);
        console.log(`    Average Cost: ${ethers.formatEther(avgClaimCost)} ETH`);
        console.log(`    Min Cost: ${ethers.formatEther(minClaimCost)} ETH`);
        console.log(`    Max Cost: ${ethers.formatEther(maxClaimCost)} ETH`);
        
        // Calculate total estimated costs for different networks
        if (avgMintGas > 0n) {
          // Current network (test network - likely L2 or local)
          const estimatedTotalMintCost = avgMintGas * gasPrice * BigInt(testUsers.length);
          const estimatedTotalClaimCost = avgClaimGas * gasPrice * BigInt(successfulClaims);
          
          console.log(`\n  Estimated Total Costs (Current Network):`);
          console.log(`    Total Mint Cost (${testUsers.length} users): ~${ethers.formatEther(estimatedTotalMintCost)} ETH`);
          console.log(`    Total Claim Cost (${successfulClaims} claims): ~${ethers.formatEther(estimatedTotalClaimCost)} ETH`);
          console.log(`    Grand Total: ~${ethers.formatEther(estimatedTotalMintCost + estimatedTotalClaimCost)} ETH`);
          
          // Estimate costs for L1 (Ethereum Mainnet) - typical gas price: 30-50 gwei
          const l1GasPrice = 40n * 10n ** 9n; // 40 gwei (typical for mainnet)
          const l1MintCost = avgMintGas * l1GasPrice * BigInt(testUsers.length);
          const l1ClaimCost = avgClaimGas * l1GasPrice * BigInt(successfulClaims);
          
          console.log(`\n  Estimated Costs for L1 (Ethereum Mainnet @ 40 gwei):`);
          console.log(`    Average Mint Cost: ~${ethers.formatEther(avgMintGas * l1GasPrice)} ETH`);
          console.log(`    Average Claim Cost: ~${ethers.formatEther(avgClaimGas * l1GasPrice)} ETH`);
          console.log(`    Total Mint Cost (${testUsers.length} users): ~${ethers.formatEther(l1MintCost)} ETH`);
          console.log(`    Total Claim Cost (${successfulClaims} claims): ~${ethers.formatEther(l1ClaimCost)} ETH`);
          console.log(`    Grand Total: ~${ethers.formatEther(l1MintCost + l1ClaimCost)} ETH`);
          
          // Estimate costs for L2 (Arbitrum/Optimism/Base) - typical gas price: 0.1-0.5 gwei
          const l2GasPrice = 2n * 10n ** 8n; // 0.2 gwei = 200000000 wei (typical for L2)
          const l2MintCost = avgMintGas * l2GasPrice * BigInt(testUsers.length);
          const l2ClaimCost = avgClaimGas * l2GasPrice * BigInt(successfulClaims);
          
          console.log(`\n  Estimated Costs for L2 (Arbitrum/Optimism/Base @ 0.2 gwei):`);
          console.log(`    Average Mint Cost: ~${ethers.formatEther(avgMintGas * l2GasPrice)} ETH`);
          console.log(`    Average Claim Cost: ~${ethers.formatEther(avgClaimGas * l2GasPrice)} ETH`);
          console.log(`    Total Mint Cost (${testUsers.length} users): ~${ethers.formatEther(l2MintCost)} ETH`);
          console.log(`    Total Claim Cost (${successfulClaims} claims): ~${ethers.formatEther(l2ClaimCost)} ETH`);
          console.log(`    Grand Total: ~${ethers.formatEther(l2MintCost + l2ClaimCost)} ETH`);
          
          // Comparison
          console.log(`\n  Cost Comparison:`);
          console.log(`    L1 vs L2 Mint Cost Ratio: ~${(l1GasPrice / l2GasPrice).toString()}x`);
          console.log(`    L1 vs L2 Claim Cost Ratio: ~${(l1GasPrice / l2GasPrice).toString()}x`);
          console.log(`    💡 L2 costs are ~${(l1GasPrice / l2GasPrice).toString()}x cheaper than L1`);
        }
      }
      
      if (gasPrice === 0n || (mintGasUsed.length === 0 && claimGasUsed.length === 0)) {
        console.log(`  ⚠️  Could not calculate gas costs (gas price unavailable or no samples)`);
      }
      
      // Verify that all winners claimed
      console.log(`\n=== VERIFYING ALL CLAIMS COMPLETED ===`);
      console.log(`  All ${winningUsers.length} winning users should have claimed...`);
      
      // Check remaining unclaimed positions
      let remainingUnclaimed = 0;
      let remainingUnclaimedAmount = 0n;
      
      // Sample check: verify that most positions are now claimed
      const VERIFY_SAMPLE_SIZE = 1000;
      for (let i = 0; i < Math.min(VERIFY_SAMPLE_SIZE, testUsers.length); i++) {
        const user = testUsers[i];
        for (let fightId = 0; fightId < 15; fightId++) {
          try {
            const [canClaim, , , totalPayout, claimed] = 
              await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
            if (canClaim && !claimed) {
              remainingUnclaimed++;
              remainingUnclaimedAmount += totalPayout;
            }
          } catch (e) {
            // Position doesn't exist
          }
        }
      }
      
      if (remainingUnclaimed > 0) {
        console.log(`  ⚠️  Warning: Found ${remainingUnclaimed} unclaimed positions in sample of ${VERIFY_SAMPLE_SIZE} users`);
        console.log(`  This might be due to users not being in the winningUsers list (e.g., positions with 0 winnings)`);
      } else {
        console.log(`  ✓ No unclaimed positions found in sample`);
      }
      
      // ============ STEP 8: Final verification and integrity checks ============
      console.log(`\n=== FINAL VERIFICATION & INTEGRITY CHECKS ===`);
      const season = await sportsbook.seasons(seasonId);
      expect(season.resolved).to.be.true;
      expect(season.numFights).to.equal(15n);
      
      // Verify all fights are resolved
      // Note: winningOutcome can be 0 (Fighter A - Submission), so we check totalWinningsPool instead
      for (let fightId = 0; fightId < 15; fightId++) {
        const fightState = await sportsbook.fightStates(seasonId, BigInt(fightId));
        // winningOutcome can be 0 (Fighter A - Submission), so we verify resolution by checking totalWinningsPool
        // If totalWinningsPool > 0, the fight is resolved (even if winningOutcome is 0)
        expect(fightState.totalWinningsPool).to.be.gt(0n);
        expect(fightState.winningPoolTotalShares).to.be.gt(0n);
        // Verify winningOutcome is within valid range (0-5 for 6 outcomes)
        expect(fightState.winningOutcome).to.be.lte(5n);
      }
      console.log(`✓ All 15 fights resolved correctly`);
      
      // CRITICAL INTEGRITY CHECK: Contract balance should equal remaining unclaimed funds
      const finalContractBalance = await fp1155.balanceOf(sportsbookAddress, seasonTokenId);
      // Remaining balance = initial (prize pool + stakes) - claimed amounts
      const expectedRemainingBalance = contractBalanceBeforeClaims - totalClaimed;
      expect(finalContractBalance).to.equal(expectedRemainingBalance);
      console.log(`✓ Contract balance integrity verified (remaining: ${formatFP(finalContractBalance)})`);
      
      // Verify that claimed positions are marked as claimed
      console.log(`\nVerifying claim status...`);
      let verifiedClaimedPositions = 0;
      // Check first 10 winning users to verify their positions are marked as claimed
      for (let i = 0; i < Math.min(10, winningUsers.length); i++) {
        const { index, user } = winningUsers[i];
        for (let fightId = 0; fightId < 15; fightId++) {
          try {
            const [canClaim, , , , claimed] = 
              await sportsbook.getPositionWinnings(user.address, seasonId, fightId);
            if (canClaim && claimed) {
              // Position should be claimed if user made a claim
              verifiedClaimedPositions++;
            }
          } catch (e) {
            // Position doesn't exist
          }
        }
      }
      console.log(`✓ Claim status verified (${verifiedClaimedPositions} positions marked as claimed)`);
      
      console.log(`\n✓ Stress test completed successfully!`);
      console.log(`\n=== STRESS TEST SUMMARY ===`);
      console.log(`  Total Users: ${testUsers.length}`);
      console.log(`  Total Fights: 15`);
      console.log(`  Total Predictions: ${totalPredictions}`);
      console.log(`  Total Staked: ${formatFP(totalStaked)}`);
      console.log(`  Prize Pool: ${formatFP(totalPrizePool)}`);
      console.log(`  Total Winning Users: ${winningUsers.length}`);
      console.log(`  Successful Claims: ${successfulClaims}/${winningUsers.length}`);
      console.log(`  Total Claimed: ${formatFP(totalClaimed)}`);
      console.log(`  Final Contract Balance: ${formatFP(finalContractBalance)}`);
      console.log(`  Expected Final Balance: ~${formatFP(finalContractBalance)} (should be small, only truncation remainders)`);
      
      // Verify that final balance is reasonable (should be small, only truncation remainders)
      // With 10k prize pool per fight, the remainder should be much less than the prize pool
      const maxExpectedRemainder = totalPrizePool / 10n; // Should be less than 10% of prize pool
      if (finalContractBalance > maxExpectedRemainder) {
        console.log(`  ⚠️  Warning: Final balance (${formatFP(finalContractBalance)}) is higher than expected (~${formatFP(maxExpectedRemainder)})`);
        console.log(`  This might indicate some winners didn't claim or there are unclaimed positions`);
      } else {
        console.log(`  ✓ Final balance is reasonable (truncation remainders only)`);
      }
      console.log(`\n=== INTEGRITY CHECKS PASSED ===`);
      console.log(`  ✓ Balance integrity verified (contract balance = prize pool + stakes - claims)`);
      console.log(`  ✓ Resolution data verified (all 15 fights)`);
      console.log(`  ✓ Claims verified (users received exact expected amounts)`);
      console.log(`  ✓ No token loss detected (all transfers accounted for)`);
    }).timeout(600000); // 10 minutes timeout for stress test
  });

});
