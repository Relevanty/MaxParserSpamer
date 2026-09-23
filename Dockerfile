FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY src/ ./src/
COPY tools/ ./tools/

# Start the application
# We use tools/start.js directly as the entry point
CMD ["node", "tools/start.js"]
