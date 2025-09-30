import { getTestServerTools } from './src/app/mcp-servers/mcp-client.js';

async function testToolsCount() {
  console.log('Testing test-server tools count...');
  
  try {
    const tools = await getTestServerTools();
    console.log('Test server tools count:', tools.length);
    console.log('Tools:');
    tools.forEach((tool, index) => {
      console.log(`  ${index + 1}. ${tool.name} - ${tool.description || 'No description'}`);
    });
  } catch (error) {
    console.error('Error getting tools:', error.message);
    console.error('Stack:', error.stack);
  }
}

testToolsCount().then(() => {
  console.log('Test completed');
  process.exit(0);
}).catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});