import { app } from './server/app.js';

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Delivery Tool running on http://localhost:${PORT}`);
});
