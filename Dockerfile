FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/app.js"]