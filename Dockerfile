# syntax=docker/dockerfile:1

# Aucune dépendance : le serveur n'utilise que la bibliothèque standard de Node, donc pas
# d'étape de construction. Il tourne sans privilège (uid 1000, utilisateur `node`).
FROM node:26-alpine
# Rattache le paquet GHCR au dépôt : il en hérite la visibilité (publique).
LABEL org.opencontainers.image.source="https://github.com/gauthiercpx/burgerrun"
WORKDIR /app
COPY server.js index.html ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.js"]
