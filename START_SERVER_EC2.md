# Starte serveren på EC2

## Steg 1: Koble til EC2

```bash
ssh -i din-nøkkel.pem ec2-user@13.53.214.56
```

## Steg 2: Naviger til prosjektmappen

```bash
cd ~/BrRegister
# eller
cd ~/BR-register
```

## Steg 3: Hent siste endringer

```bash
git pull
```

## Steg 4: Bygg prosjektet

```bash
npm run build
```

## Steg 5: Start serveren

```bash
npm start
```

Du skal se:
```
🚀 Server kjører på http://localhost:3000
   -> Besøk http://localhost:3000/ for å se selskaper
   -> Besøk http://localhost:3000/annual-reports.html for å se årsregnskap
```

## Steg 6: Åpne i nettleseren

**Riktig URL:**
```
http://13.53.214.56:3000/annual-reports.html
```

**VIKTIG:**
- Bruk `http://` (ikke `https://`)
- Inkluder portnummeret `:3000`

## Steg 7: Sjekk Security Group

Hvis siden fortsatt ikke fungerer, må du åpne port 3000 i Security Group:

1. Gå til AWS Console: https://console.aws.amazon.com/ec2/
2. Klikk på din EC2-instans
3. Gå til "Security" tab → Klikk på Security Group
4. Klikk "Edit inbound rules"
5. Legg til regel:
   - Type: Custom TCP
   - Port: 3000
   - Source: 0.0.0.0/0 (eller din IP for bedre sikkerhet)
   - Description: HTTP server for BR-register
6. Klikk "Save rules"

## Kjør serveren i bakgrunnen (valgfritt)

Hvis du vil at serveren skal kjøre selv etter at du lukker SSH-tilkoblingen:

```bash
# Bruk nohup
nohup npm start > server.log 2>&1 &

# Eller bruk screen
screen -S br-register
npm start
# Trykk Ctrl+A, deretter D for å detache
```

For å se serveren igjen:
```bash
screen -r br-register
```

## Feilsøking

### "Cannot find module"
```bash
npm install
npm run build
```

### "Port 3000 already in use"
```bash
# Finn prosessen som bruker port 3000
sudo lsof -i :3000
# Stopp prosessen
kill -9 <PID>
```

### "Database connection timeout"
Dette er normalt hvis du prøver å koble til fra lokal maskin. Serveren må kjøre på EC2 for å ha tilgang til databasen.

