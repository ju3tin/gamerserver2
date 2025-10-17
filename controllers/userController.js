const User = require('../models/User');

const handleCreateUser = async (ws, data) => {
  const { username, walletAddress } = data;

  if (!username || !walletAddress) {
    return ws.send(JSON.stringify({ action: 'ERROR', message: 'Username and wallet address are required.' }));
  }

  try {
    // Check if username or wallet already exists
    const existingUser = await User.findOne({ $or: [{ username }, { walletAddress }] });
    if (existingUser) {
      return ws.send(JSON.stringify({ action: 'ERROR', message: 'Username or wallet address already exists.' }));
    }

    const user = new User({
      username,
      walletAddress,
      balances: { SOL: 1000, CHIPPY: 1000, DEMO: 1000 }
    });
    await user.save();

    ws.send(JSON.stringify({
      action: 'USER_CREATED',
      userId: user._id,
      username: user.username,
      walletAddress: user.walletAddress,
      balances: user.balances
    }));
  } catch (err) {
    console.error(err);
    ws.send(JSON.stringify({ action: 'ERROR', message: 'Failed to create user.' }));
  }
};

module.exports = { handleCreateUser };
