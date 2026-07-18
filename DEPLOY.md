# Ανέβασμα στο Railway (με τη βάση δεδομένων)

Οδηγός για να τρέξει η εφαρμογή online στο **Railway**, με **αντίγραφο**
της τοπικής σου βάσης. Το τοπικό XAMPP μένει ανέπαφο — μεταφέρουμε copy.

Ο κώδικας είναι ήδη έτοιμος: το [`src/db/config.js`](src/db/config.js)
διαβάζει αυτόματα τις μεταβλητές της βάσης του Railway (`MYSQL_URL`).

---

## 0. Τι θα χρειαστείς
- Λογαριασμό **GitHub** (το repo υπάρχει ήδη: `Nikoliadis/Intelli-Program`).
- Λογαριασμό **Railway** (railway.app) — ~5$/μήνα hobby μετά το trial.
- Το **XAMPP** ανοιχτό στον υπολογιστή σου (για την εξαγωγή της βάσης).

---

## 1. Ανέβασε τον κώδικα στο GitHub
Από το φάκελο του project:
```bash
git add -A
git commit -m "Deploy config for Railway"
git push
```

## 2. Φτιάξε το project στο Railway
1. railway.app → **New Project** → **Deploy from GitHub repo** → διάλεξε
   `Intelli-Program`.
2. Το Railway θα το «χτίσει» μόνο του (βλέπει το `npm start`). Θα βγάλει
   σφάλμα βάσης προς το παρόν — δεν πειράζει, θα τη συνδέσουμε στο βήμα 3.

## 3. Πρόσθεσε τη βάση MySQL
1. Μέσα στο project: **+ New** → **Database** → **Add MySQL**.
2. Πήγαινε στο **service της εφαρμογής** → καρτέλα **Variables** → **New Variable**
   και βάλε (με το reference του Railway):
   ```
   MYSQL_URL = ${{MySQL.MYSQL_URL}}
   SESSION_SECRET = <βάλε-μια-μεγάλη-τυχαία-φράση>
   ```
   (Το `MYSQL_URL` δείχνει στην εσωτερική, γρήγορη σύνδεση της βάσης.)

## 4. Μετέφερε τα δεδομένα (το σημαντικό!)
**α) Εξαγωγή από την τοπική βάση** (Git Bash / PowerShell στον φάκελο του project):
```bash
"/c/xampp/mysql/bin/mysqldump" -u root --default-character-set=utf8mb4 \
  --no-tablespaces programa_vardion > dump.sql
```
(Αν έχεις κωδικό στη root: πρόσθεσε `-p` και δώσ' τον.)

**β) Βρες τα στοιχεία σύνδεσης του Railway:** στο MySQL service → καρτέλα
**Variables** → αντίγραψε το **`MYSQL_PUBLIC_URL`** (μοιάζει με
`mysql://root:XXXX@host.proxy.rlwy.net:12345/railway`).

**γ) Εισαγωγή στο Railway** — σπάσε το URL στα κομμάτια του:
```bash
"/c/xampp/mysql/bin/mysql" -h host.proxy.rlwy.net -P 12345 -u root -pXXXX \
  --default-character-set=utf8mb4 railway < dump.sql
```
(host / port / κωδικός από το `MYSQL_PUBLIC_URL`. Το όνομα βάσης είναι `railway`.)

> Εναλλακτικά: στο MySQL service, καρτέλα **Data**, υπάρχει έτοιμη εντολή
> σύνδεσης — μπορείς να την τρέξεις και μετά `source dump.sql`.

## 5. Ξαναφόρτωσε την εφαρμογή
Στο service της εφαρμογής → **Deployments** → **Redeploy** (ώστε να ξαναπιάσει
τη βάση με τα δεδομένα). Έπειτα **Settings** → **Networking** → **Generate Domain**
για να πάρεις δημόσιο link.

## 6. Άλλαξε τον κωδικό (ΑΠΑΡΑΙΤΗΤΟ — φύγε από admin/admin)
Επειδή το app θα είναι δημόσιο με ονόματα/προγράμματα υπαλλήλων:
1. Στο service της εφαρμογής → καρτέλα **Settings** → ίσως χρειαστεί προσωρινά
   πρόσβαση με τα Railway CLI, ή απλούστερα τρέξ' το **τοπικά με τις env του
   Railway**:
   ```bash
   DATABASE_URL="<το-MYSQL_PUBLIC_URL>" node scripts/set_password.js admin <ΝΕΟΣ_ΚΩΔΙΚΟΣ>
   ```
   (Το `scripts/set_password.js` αλλάζει τον κωδικό στη βάση.)

## 7. Έλεγχος ότι όλα παίζουν
Άνοιξε: `https://<το-domain-σου>/api/health` — πρέπει να δείξει
`ok: true` με τα πλήθη (agents, requirements κ.λπ.). Μετά μπες στο app,
κάνε login με τον νέο κωδικό, και βεβαιώσου ότι βλέπεις τα δεδομένα σου.

---

## Καλό να ξέρεις
- **Sessions:** κρατιούνται στη μνήμη του server. Σε κάθε νέο deploy/restart
  θα χρειαστεί νέο login — δεν χάνεται τίποτα άλλο. (Αν σε ενοχλεί, το κάνουμε
  να αποθηκεύει τα sessions στη βάση — μικρή προσθήκη.)
- **Μελλοντικές αλλαγές κώδικα:** `git push` → το Railway ξανακάνει deploy μόνο του.
- **Backups:** κάθε τόσο τρέξε ξανά το `mysqldump` (βήμα 4α) πάνω στη βάση
  του Railway για να κρατάς αντίγραφο.
