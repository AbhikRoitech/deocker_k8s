# client/Dockerfile
# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # produces /app/dist

# --- serve stage ---
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Proxy /api to the backend + SPA fallback so React Router deep links work.
# NOTE: "api" is the API container's name on the shared docker network (todo-net).
# In EKS the ALB path-routes /api to the backend, so this location is simply unused there.
RUN printf 'server {\n listen 80;\n root /usr/share/nginx/html;\n location /api/ { proxy_pass http://api:8000; }\n location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80