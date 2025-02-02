FROM node:20-alpine

WORKDIR /app

COPY package.json .

RUN npm install

RUN apt-get update && apt-get install -y ffmpeg

COPY . .



EXPOSE 3000

CMD ["npm", "run", "start"]