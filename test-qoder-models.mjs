import { fetch } from 'node-fetch';

const TOKEN = 'dt-M5jsviLwDKEYRxtIoYaN2sTl';

async function testQoderAPI() {
  console.log('Testing Qoder API with token: dt-M5j...Tl\n');
  
  // Test quota usage endpoint (requires bearer token)
  console.log('1. Testing Quota Usage endpoint...');
  try {
    const resp = await fetch('https://openapi.qoder.sh/api/v1/quota/usage', {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    console.log(`   Status: ${resp.status}`);
    if (resp.ok) {
      const data = await resp.json();
      console.log('   Success! Response:', JSON.stringify(data, null, 2).slice(0, 500));
    } else {
      const text = await resp.text();
      console.log('   Error:', text.slice(0, 300));
    }
  } catch (err) {
    console.log(`   Failed: ${err.message}`);
  }
  
  console.log('\n2. Testing Model List endpoint (needs COSY signing)...');
  try {
    const resp = await fetch('https://api3.qoder.sh/algo/api/v2/model/list', {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    console.log(`   Status: ${resp.status}`);
    if (resp.ok) {
      const data = await resp.json();
      console.log('   Models found:', data.chat?.length || 0);
      if (data.chat && Array.isArray(data.chat)) {
        console.log('\n   Available models:');
        data.chat.forEach(m => {
          console.log(`   - ${m.key}: ${m.display_name || m.key} (${m.enable ? 'enabled' : 'disabled'})`);
        });
      }
    } else {
      const text = await resp.text();
      console.log('   Error:', text.slice(0, 300));
    }
  } catch (err) {
    console.log(`   Failed: ${err.message}`);
  }
}

testQoderAPI().catch(console.error);
