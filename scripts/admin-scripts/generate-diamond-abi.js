const fs = require('fs');
const path = require('path');

async function main() {
    console.log("🔨 Generating Diamond Combined ABI...");
    
    const artifactsDir = path.join(__dirname, '../../artifacts/contracts');
    const outputPath = path.join(__dirname, '../../diamond-combined-abi.json');
    
    // List of facet contract names to include
    const facetNames = [
        'ConditionalTokensFacet',
        'ConditionManagerFacet', 
        'AdminConfigFacet',
        'ERC1155Facet',
        'DiamondCutFacet',
        'DiamondLoupeFacet',
        'OwnershipFacet',
        'ExchangeFacet',
        'MarketDataFacet',
        'MarketExecutionFacet',
        'AccessControlFacet',
        'ERC1155ReceiverFacet',
        'RouteSimulationFacet'
    ];
    
    const combinedAbi = [];
    const seenSignatures = new Set();
    const conflictingFunctions = new Map();
    
    console.log("📁 Scanning facets...");
    
    for (const facetName of facetNames) {
        try {
            // Find the artifact file
            const artifactPath = findArtifactPath(artifactsDir, facetName);
            
            if (!artifactPath) {
                console.log(`⚠️  Artifact not found for ${facetName}, skipping...`);
                continue;
            }
            
            console.log(`📄 Processing ${facetName}...`);
            
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            const abi = artifact.abi;
            
            if (!abi || !Array.isArray(abi)) {
                console.log(`⚠️  No valid ABI found for ${facetName}, skipping...`);
                continue;
            }
            
            // Process each ABI entry
            for (const abiEntry of abi) {
                const signature = getSignature(abiEntry);
                
                if (seenSignatures.has(signature)) {
                    // Check if it's actually a conflict (different implementations)
                    const existing = combinedAbi.find(entry => getSignature(entry) === signature);
                    if (!isEqual(existing, abiEntry)) {
                        if (!conflictingFunctions.has(signature)) {
                            conflictingFunctions.set(signature, []);
                        }
                        conflictingFunctions.get(signature).push({
                            facet: facetName,
                            entry: abiEntry
                        });
                    }
                    continue;
                }
                
                seenSignatures.add(signature);
                combinedAbi.push({
                    ...abiEntry,
                    _facet: facetName // Add metadata about which facet this came from
                });
            }
            
            console.log(`✅ Added ${abi.length} entries from ${facetName}`);
            
        } catch (error) {
            console.error(`❌ Error processing ${facetName}:`, error.message);
        }
    }
    
    // Report conflicts
    if (conflictingFunctions.size > 0) {
        console.log("\n⚠️  Found conflicting function signatures:");
        for (const [signature, conflicts] of conflictingFunctions) {
            console.log(`  ${signature}:`);
            for (const conflict of conflicts) {
                console.log(`    - ${conflict.facet}`);
            }
        }
    }
    
    // Sort ABI entries by type and name for better organization
    combinedAbi.sort((a, b) => {
        // Sort order: constructor, function, event, error
        const typeOrder = { constructor: 0, function: 1, event: 2, error: 3 };
        const aOrder = typeOrder[a.type] || 999;
        const bOrder = typeOrder[b.type] || 999;
        
        if (aOrder !== bOrder) {
            return aOrder - bOrder;
        }
        
        // Within same type, sort by name
        const aName = a.name || '';
        const bName = b.name || '';
        return aName.localeCompare(bName);
    });
    
    // Create output object with metadata
    const output = {
        contractName: "Diamond",
        description: "Combined ABI for Diamond contract with all facets",
        generatedAt: new Date().toISOString(),
        facets: facetNames,
        totalEntries: combinedAbi.length,
        entriesByType: countByType(combinedAbi),
        abi: combinedAbi.map(entry => {
            // Remove our metadata from the final ABI
            const { _facet, ...cleanEntry } = entry;
            return cleanEntry;
        })
    };
    
    // Write to file
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    
    console.log(`\n✅ Combined ABI generated successfully!`);
    console.log(`📁 Output: ${outputPath}`);
    console.log(`📊 Total entries: ${combinedAbi.length}`);
    console.log(`📋 Breakdown:`);
    for (const [type, count] of Object.entries(output.entriesByType)) {
        console.log(`  ${type}: ${count}`);
    }
    
    // Also create a simple ABI-only file for easy import
    const simpleAbiPath = path.join(__dirname, '../../diamond-abi.json');
    fs.writeFileSync(simpleAbiPath, JSON.stringify(output.abi, null, 2));
    console.log(`📄 Simple ABI: ${simpleAbiPath}`);
    
    console.log("\n💡 Usage in code:");
    console.log(`const diamondAbi = require('./diamond-abi.json');`);
    console.log(`const diamond = new ethers.Contract(address, diamondAbi, signer);`);
}

function findArtifactPath(artifactsDir, contractName) {
    // Search for the artifact file recursively
    function searchDir(dir) {
        const items = fs.readdirSync(dir);
        
        for (const item of items) {
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                const result = searchDir(itemPath);
                if (result) return result;
            } else if (item === `${contractName}.json`) {
                return itemPath;
            }
        }
        
        return null;
    }
    
    return searchDir(artifactsDir);
}

function getSignature(abiEntry) {
    if (abiEntry.type === 'function') {
        const inputs = abiEntry.inputs || [];
        const params = inputs.map(input => input.type).join(',');
        return `${abiEntry.name}(${params})`;
    } else if (abiEntry.type === 'event') {
        const inputs = abiEntry.inputs || [];
        const params = inputs.map(input => input.type).join(',');
        return `event ${abiEntry.name}(${params})`;
    } else if (abiEntry.type === 'error') {
        const inputs = abiEntry.inputs || [];
        const params = inputs.map(input => input.type).join(',');
        return `error ${abiEntry.name}(${params})`;
    } else {
        return `${abiEntry.type}_${abiEntry.name || 'unnamed'}`;
    }
}

function isEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function countByType(abi) {
    const counts = {};
    for (const entry of abi) {
        counts[entry.type] = (counts[entry.type] || 0) + 1;
    }
    return counts;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error:", error);
        process.exit(1);
    });
