const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function runScript(scriptPath, description) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚀 ${description}`);
    console.log(`📄 Running: ${scriptPath}`);
    console.log(`${'='.repeat(80)}\n`);
    
    try {
        const { stdout, stderr } = await execAsync(`npx hardhat run ${scriptPath} --network baseSepolia`);
        console.log(stdout);
        if (stderr) {
            console.log('⚠️ Warnings:', stderr);
        }
        console.log(`✅ ${description} - COMPLETED\n`);
        return true;
    } catch (error) {
        console.error(`❌ ${description} - FAILED`);
        console.error('Error:', error.message);
        if (error.stdout) console.log('Output:', error.stdout);
        if (error.stderr) console.log('Error details:', error.stderr);
        return false;
    }
}

async function main() {
    console.log('🌟 DoeFin V2 - Complete Admin Setup Workflow');
    console.log('📋 This script will run all admin scripts in the correct order');
    console.log('⚠️  Make sure your .env file has DIAMOND_ADDRESS set!\n');
    
    // Wait for user confirmation
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const scripts = [
        {
            path: 'scripts/admin-scripts/1-deploy-mock-token-and-add-collateral.js',
            description: 'Step 1: Deploy Mock Token & Add Collateral',
            required: true
        },
        {
            path: 'scripts/admin-scripts/2-add-market-maker.js', 
            description: 'Step 2: Add Market Maker Role',
            required: true
        },
        {
            path: 'scripts/admin-scripts/3-mint-and-approve-tokens.js',
            description: 'Step 3: Mint & Approve Tokens',
            required: true
        },
        {
            path: 'scripts/admin-scripts/4-create-condition.js',
            description: 'Step 4: Create Prediction Condition', 
            required: true
        },
        {
            path: 'scripts/admin-scripts/5-split-condition.js',
            description: 'Step 5: Split Condition (Create Position Tokens)',
            required: true
        },
        {
            path: 'scripts/admin-scripts/6-create-orders.js',
            description: 'Step 6: Create Sample Orders',
            required: false
        }
    ];
    
    let successCount = 0;
    let failureCount = 0;
    
    for (const script of scripts) {
        const success = await runScript(script.path, script.description);
        
        if (success) {
            successCount++;
        } else {
            failureCount++;
            
            if (script.required) {
                console.log(`❌ Required script failed: ${script.description}`);
                console.log('🛑 Stopping workflow due to required script failure');
                break;
            } else {
                console.log(`⚠️ Optional script failed: ${script.description}`);
                console.log('▶️ Continuing with next script...\n');
            }
        }
        
        // Add delay between scripts
        if (script !== scripts[scripts.length - 1]) {
            console.log('⏳ Waiting 3 seconds before next script...\n');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log('🎉 WORKFLOW COMPLETE');
    console.log(`${'='.repeat(80)}`);
    console.log(`✅ Successful: ${successCount}`);
    console.log(`❌ Failed: ${failureCount}`);
    console.log(`📊 Total: ${scripts.length}`);
    
    if (successCount >= 4) { // At least the required scripts
        console.log('\n🎉 Minimum setup complete! Your prediction market is ready.');
        console.log('\n🔄 Next Steps:');
        console.log('   1. Check your .env file for generated addresses and IDs');
        console.log('   2. Run position token verification:');
        console.log('      npx hardhat run scripts/admin-scripts/17-verify-position-tokens.js --network baseSepolia');
    } else {
        console.log('\n⚠️ Setup incomplete. Please check errors above and rerun failed scripts.');
    }
    
    console.log(`\n${'='.repeat(80)}\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Workflow failed:', error);
        process.exit(1);
    });