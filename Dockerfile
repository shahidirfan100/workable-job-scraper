# Use the official Node.js image as the base image
FROM apify/actor-node-playwright:latest

# Set the working directory in the container
WORKDIR /home/myuser

# Copy the package.json and package-lock.json (if available) to the container
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the source code to the container
COPY . ./

# Build the project
RUN npm run build

# Set the command to run the actor
CMD ["npm", "start"]