const res = await fetch("http://localhost:5000/api/conversations");
const convs = await res.json();
const igConvs = convs.filter(c => 
  c.channel?.toLowerCase().includes("instagram") || 
  c.platform?.toLowerCase().includes("instax") || 
  c.platform?.toLowerCase().includes("instagram") ||
  c.metadata?.account === "@techvaseegrah"
);
console.log(`Total conversations: ${convs.length}`);
console.log(`Instagram/InstaxBot conversations: ${igConvs.length}`);
igConvs.forEach(c => {
  console.log(`- [${c.id}] Name: ${c.customerName} | Platform: ${c.platform} | Channel: ${c.channel} | Type: ${c.metadata?.lastMessageType || c.metadata?.type || 'N/A'} | LastMsg: ${c.lastMessage?.slice(0, 50)}`);
});
