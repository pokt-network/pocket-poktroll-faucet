# Use the official Node.js image as base
FROM node:latest

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install yarn

RUN yarn install
# Copy the rest of the application code to the working directory
COPY . .

# Change ownership of the working directory to the 'node' user
RUN chown -R node:node .

# Switch to the 'node' user
USER node

# Expose the port your app runs on
EXPOSE 8088

# Command to run your application
CMD ["node", "faucet.js"]
