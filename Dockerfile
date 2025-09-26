# Use the official Node.js image as the base image
FROM apify/actor-node-playwright:latest

# Set the working directory in the container
WORKDIR /home/myuser

# Copy the package.json and package-lock.json (if available) to the container
COPY package*.json ./

# Install production dependencies first
RUN npm install --production

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

# Copy the rest of the source code to the container
COPY . ./

# Install dev dependencies for building
RUN npm install --include=dev

# Build the project
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Set the command to run the actor
CMD ["npm", "start"]