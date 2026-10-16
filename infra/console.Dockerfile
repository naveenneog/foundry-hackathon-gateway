# Key Console image (P46, ADR-0014). Built by scripts/Deploy-Console.ps1 with `az acr build` from a
# context that holds only src/keys.mjs, src/console/** and a minimal package.json: no dependencies,
# no tests, no repo history.
FROM mcr.microsoft.com/azurelinux/base/nodejs:20
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER 1000:1000
CMD ["node", "src/console/main.mjs"]
