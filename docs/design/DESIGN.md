# Heph — specifica di design (approvata)

Questo documento accompagna i mockup in `mockups/` e gli screenshot in `screenshots/`. Insieme descrivono l'interfaccia approvata di **Hephaestus (Heph)**. Il brief funzionale originale è in `BRIEF.md`.

**Direzione:** la *struttura* del Device Builder di ESPHome (filtri a sinistra, griglia di riquadri, barra di selezione multipla, coda di lavori, elenco dei progetti a sinistra nella pagina progetto) con lo *stile* di GitHub/Primer, in tema scuro: barra nera, menu a schede sottolineate, riquadri con intestazione, etichette a contorno, bottone primario verde, icone tonde dei task, diario come linea del tempo.

**Tema:** si progetta e si implementa **solo il tema scuro**. La variante chiara è esclusa per ora, ma usa comunque i token di `tokens.css` così si potrà aggiungere in seguito.

---

## 1. Come usare questo pacchetto

| Cartella / file | Contenuto | Uso |
|---|---|---|
| `mockups/` | 26 pagine HTML statiche, autonome, collegate fra loro | Riferimento visivo e di markup. Aprile nel browser. Non sono codice di produzione: stili inline e dati finti. |
| `screenshots/` | PNG di ogni pagina (desktop 1440 px, telefono 390 px @2x) | Confronto visivo rapido |
| `index.html` | Indice di tutte le schermate | Punto di partenza |
| `tokens.css` | Variabili CSS (colori, tipografia, spazi, raggi, altezze) | **Fonte unica** dei valori: importala e usa le variabili |
| `tokens.json` | Gli stessi token in JSON | Per Tailwind, theme provider, ecc. |
| `DESIGN.md` | Questo documento | Regole, componenti, comportamenti |
| `BRIEF.md` | Brief funzionale originale | Requisiti |

**Regole per l'implementazione**
- Ricava componenti riutilizzabili (sezione 4): nei mockup lo stesso markup è ripetuto inline.
- Tutti i testi sono di esempio (progetti, date, numeri, comandi). Vengono dai dati reali e dalle traduzioni IT/EN.
- I comandi nella sezione «Collega Claude Code» delle Impostazioni sono un **esempio**: la sintassi reale dipende da come implementerai il server.
- Nei mockup le icone sono caratteri o SVG semplici. In produzione usa un set di icone coerente a tratto sottile (per esempio Lucide o Octicons, licenza MIT), mantenendo forme e significati.

---

## 2. Principi

1. **Dove ero, cosa faccio adesso, cosa manca.** Ogni pagina progetto mette in cima il *prossimo passo*, poi lo stato (test o Claude al lavoro), poi il *percorso*, poi roadmap e diario.
2. **Chi ha fatto cosa.** Ogni voce ha una fonte riconoscibile da colore *e* sigla: **TU** (blu), **IA**/Claude (viola), **GH** GitHub (grigio scuro), **SYS** sistema (grigio). Il viola è riservato a Claude in tutta l'app.
3. **Cosa sta facendo Claude adesso.** Un pallino viola pulsante (1 s) segnala un lavoro in corso: nell'etichetta di stato, nella coda di Claude, nelle sessioni del diario e nell'avviso in cima alla pagina progetto.
4. **Densità leggibile.** Testo base 14 px, righe da 36–44 px, informazioni secondarie in grigio a 12 px. Niente titoli giganti.
5. **Le cose che aspettano te emergono.** Ambra per i test manuali e per il prossimo passo, rosso per i progetti fermi o senza prossimo passo, viola per le proposte di Claude.

---

## 3. Fondamenti

Tutti i valori sono in `tokens.css`.

- **Tipografia:** caratteri di sistema (`--font-sans`) e monospazio di sistema per hash, comandi e percorsi. Pesi 400/600 (500 solo nei bottoni).
- **Griglia:** spazi multipli di 4 px. Padding dei riquadri 12–16 px; distanza fra riquadri 16 px; padding della pagina 20–24 px.
- **Raggi:** 6 px per riquadri, bottoni e campi; 10–11 px per le pillole; cerchio per avatar e icone.
- **Contrasto:** il testo principale `--fg-default` su `--bg-canvas` supera 13:1. Il testo `--fg-muted` (≥ 4.5:1) va usato solo per meta, mai per contenuto necessario.
- **Focus:** bordo `--accent-emphasis` più `--focus-ring`, su ogni elemento interattivo.
- **Movimento:** solo il pallino pulsante e le barre di avanzamento indeterminate. Rispetta `prefers-reduced-motion`.

---

## 4. Componenti

| Componente | Specifica | Dove |
|---|---|---|
| **Barra in alto** | Altezza 56, sfondo `--bg-inset`. Logo tondo (32 px, bordo), percorso (`progetti / slug`), ricerca (`Digita / per cercare`, scorciatoia `/`), lingua `IT ▾`, bottone verde *Nuovo progetto*, impostazioni (ingranaggio), avatar *TU* | Tutte |
| **Menu a schede** | Link con contatore (pillola `--bg-muted`, viola per le proposte). La scheda attiva è in grassetto con sottolineatura 2 px `--nav-underline` | Dashboard, progetto |
| **Riquadro** | Bordo 1 px `--border-default`, raggio 6. Intestazione opzionale su `--bg-subtle` con titolo 600 e meta grigio. Varianti di colore: attenzione, pericolo, IA (bordo e intestazione) | Ovunque |
| **Bottone** | Standard: `--bg-muted`, bordo, 32 px (28 nelle righe). Primario: verde `--success-emphasis` con testo bianco; **uno per vista**. Pericoloso: standard con testo `--danger-text` | |
| **Controllo segmentato** | Gruppo di bottoni uniti; il segmento attivo ha sfondo `--border-default` e testo in grassetto | Riquadri/Tabella, aperti/chiusi, filtri per fonte |
| **Etichetta di stato** | Pillola alta 20 px con bordo e testo del colore di stato e un pallino da 6 px (che pulsa se Claude è attivo). Vedi la sezione 5 | Riquadri, testate, tabelle |
| **Chip del tag** | Pillola su `--accent-subtle`, testo `--accent-fg`, senza bordo | |
| **Avatar della fonte** | Cerchio da 20–22 px con sigla da 9 px: TU, IA, GH, SYS (colori nella sezione 2) | Diario, ricerca, panoramica |
| **Riga del task** | Maniglia per trascinare, icona tonda (aperto: cerchio verde con punto; chiuso: cerchio viola con spunta), numero `3.4`, titolo, etichette (`prossimo` ambra, `Claude` viola, `n file`), meta (`Claude · 20/11`), menu ⋯. Il prossimo passo ha lo sfondo `--attention-subtle`. Al passaggio del mouse compaiono *Imposta come prossimo* e *Modifica* | Roadmap, panoramica |
| **Riquadro della fase** | Intestazione con maniglia, freccia per aprire e chiudere, `n · Nome`, testo di stato, barra di avanzamento da 140 px, `x chiusi · y aperti`, menu ⋯. Le fasi completate partono chiuse; la fase in corso ha il bordo del colore di stato | Roadmap |
| **Barra di avanzamento a segmenti** | Un segmento per fase, largo in proporzione al numero di task, riempito in verde in proporzione ai task chiusi | Riquadri e tabella della dashboard |
| **Percorso** | Linea orizzontale: nodi grandi = inizio di una fase (con il nome sopra), nodi piccoli = task; pieni in verde se chiusi, vuoti se da fare. Un marcatore «sei qui» ha il colore dello stato (ambra se c'è un test, viola se Claude ci lavora). Sul telefono diventa **verticale** | Panoramica |
| **Linea del tempo** | Intestazione del giorno (cerchio e data) che resta in alto mentre scorri. Riquadri pieni per note, sessioni e commit; righe compatte con icona tonda sulla linea per gli eventi automatici | Diario |
| **Sessione di Claude** | Riquadro viola che raggruppa gli eventi di una sessione: riepilogo (✓ task, ▶ test, ▣ screenshot, ◆ stato), testo di riassunto, fila di miniature (le prime 6 e poi «+N»), *Mostra gli N eventi*. Sessione in corso: etichetta «in corso» pulsante | Diario |
| **Avvisi** | Riquadro a tutta larghezza con icona, testo e azione. Varianti: informativo (blu), attenzione (ambra), pericolo (rosso), Claude (viola) | Testate, errori |
| **Stato vuoto** | Riquadro centrato con icona tonda, titolo da 18 px, una frase su cosa comparirà e una o due azioni | Ogni scheda |
| **Segnaposto di caricamento** | Rettangoli `--bg-muted` con la stessa forma del contenuto | Dashboard, diario |
| **Coda di Claude** | Riquadro fluttuante in basso a destra, bordo viola: lavori in corso e conclusi oggi, ciascuno con barra di avanzamento; si può ridurre | Dashboard |
| **Barra di selezione multipla** | Riquadro fluttuante centrato in basso: «N selezionati» e azioni di gruppo (pausa, tag, esporta) | Dashboard |
| **Visualizzatore** | Livello sopra la pagina: immagine grande con precedente e successivo, dettagli a destra (chi l'ha caricata, a cosa è collegata, scadenza; *Fissa*, *Scarica*, *Elimina*), fila di miniature in basso. Tasti ← → ed Esc | Diario, file |
| **Editor markdown** | Schede *Scrivi / Anteprima*, area di testo, allegati come chip rimovibili, *Allega file*, *Collega a un task*, bottone primario. Ctrl+Invio per pubblicare | Diario, descrizione |
| **Campo dei tag** | Chip rimovibili più un campo con suggerimenti e l'opzione «Crea il tag …» | Nuovo e Modifica progetto |

---

## 5. Stato del progetto: cosa vede l'utente

Ciclo di vita e attività si combinano in **un'etichetta principale**, scelta in quest'ordine di priorità:

| Priorità | Condizione | Etichetta | Colore |
|---|---|---|---|
| 1 | ciclo di vita = *in attesa del mio test* | `da testare` | `--attention-fg` |
| 2 | attività = Claude esegue i test | `Claude esegue test` (pallino pulsante) | `--ai-fg` |
| 2 | attività = Claude al lavoro | `Claude al lavoro` (pallino pulsante) | `--ai-fg` |
| 3 | in sviluppo **senza prossimo passo** | `senza passo` | `--danger-fg` |
| 3 | in sviluppo e inattivo oltre la soglia | `fermo da N g` | `--danger-fg` |
| 4 | in sviluppo, attivo di recente | `attivo` | `--success-fg` |
| 4 | in sviluppo, né recente né fermo | `in sviluppo` | `--fg-muted` |
| 5 | *in pausa* (con motivo) | `in pausa` più il motivo nel riquadro | `--fg-muted` |
| 6 | *completato* / *abbandonato* | `completato` / `abbandonato` | `--ai-fg` / `--fg-muted` |

**Ordine nella dashboard** (gruppi nella tabella, ordinamento predefinito «attenzione» nei riquadri): 1 da testare → 2 Claude al lavoro o in test → 3 fermi o senza prossimo passo → 4 attivi → 5 in pausa → 6 completati e abbandonati, nascosti dietro «Mostra chiusi».

Le soglie «attivo di recente» (predefinita 3 giorni) e «fermo da tempo» (21 giorni) si impostano in Impostazioni.

---

## 6. Schermate

L'elenco completo con i collegamenti è in `index.html`. Ogni pagina si apre da sola.

### Dashboard (`01`–`04`)
- **Progetti (`01`)**: filtri a sinistra (stato, attività, tag, con conteggi), barra degli strumenti (filtro testuale, ordinamento, Riquadri/Tabella), griglia di riquadri (larghezza minima 320 px). Ogni riquadro ha: casella di selezione, nome, stato, prossimo passo, eventuale nota (test o motivo della pausa), avanzamento a segmenti con fase e percentuale, tag, «Aggiornato…», azione contestuale (*Esito test*, *Scegli passo*), *Diario*, ⋯. Il riquadro selezionato ha il bordo blu. In basso ci sono la barra di selezione e la coda di Claude.
- **Vista Tabella**: vedi `54`. Una riga per progetto, gruppi che si aprono e si chiudono, intestazione ferma in alto, nomi lunghi troncati con il nome completo al passaggio del mouse, paginazione «Mostra altri N».
- **Test (`02`)**: il test in attesa è aperto, con cosa verificare (lista numerata), allegati, campo per l'esito e *Superato / Fallito*; sotto, lo storico. *Fallito* riporta il progetto in sviluppo e salva l'esito nel diario.
- **Proposte (`03`)**: elenco simile alle pull request (in attesa / approvate / rifiutate). Una proposta aperta mostra il motivo, il riquadro **«Cosa cambia»** in stile diff (righe rosse per ciò che viene rimosso), una nota facoltativa per Claude e *Approva / Rifiuta*.
- **Diario di tutti i progetti (`04`)**: la linea del tempo di tutti i progetti, con il chip del progetto su ogni voce.

### Progetto (`10`–`15`, `21`)
Struttura comune: elenco dei progetti a sinistra (l'**unica** barra laterale, 256 px, con filtro e il progetto corrente evidenziato) e una testata (nome, stato, `13/20 · 65%`, *Modifica*, *Stato ▾*, ⋯; sotto, descrizione su una riga, link, repository e tag). Poi le schede: **Panoramica · Roadmap · Diario · Documentazione · Materiali · File**.
- **Panoramica (`10`)**, in quest'ordine: *Prossimo passo* (titolo da 22 px, *Segna fatto* primario, *Scegli un altro passo*) accanto a *Test manuale in attesa* (se c'è) → *Percorso* → *Fase attuale* (task) accanto a *Ultime dal diario*. Se Claude sta lavorando sul progetto, in cima compare un avviso viola: «Claude sta lavorando qui dalle 18:03 — ultimo evento…».
- **Roadmap (`11`)**: esattamente due livelli, fasi e task. Si trascinano per riordinarli, si aggiunge un task dentro la fase (mostrato lo stato di inserimento), si cambia il prossimo passo con *Imposta come prossimo*. Un filtro mostra i task aperti, chiusi o tutti. Una proposta di Claude che riguarda un task compare sotto quel task.
- **Diario (`12`)**: filtri per fonte con conteggi, *Tipo ▾*, *Con allegati*, ricerca, editor in cima, linea del tempo. L'esito di un test fallito ha il riquadro con bordo rosso.
- **Documentazione (`13`)**: se viene da un repository è **in sola lettura**, con un avviso (repository · percorso · ultima sincronizzazione · *Sincronizza ora*), il markdown reso come un README e un indice dei titoli. Se non viene da un repository: lo stesso riquadro con l'editor Scrivi/Anteprima.
- **Materiali (`14`)**: filtro per stato (da comprare / ordinato / arrivato / usato), quattro totali, una tabella con selezione e un'etichetta di stato che si cambia direttamente, una riga per l'inserimento rapido, *Esporta CSV*.
- **File (`15`)**: filtro per tipo, area per trascinare i file, *Fissati* (miniature grandi), poi tutti i file (miniature con l'avatar della fonte e il collegamento: fase, task o voce del diario). Un avviso ricorda la scadenza degli screenshot di Claude non fissati.
- **Modifica (`21`)**: il modulo di Nuovo progetto già compilato, più lo **stato** (cinque opzioni; *In attesa del mio test* chiede cosa verificare, *In pausa* chiede il motivo), *Esporta* (.zip / JSON) e la **zona pericolosa** (revoca la scrittura di Claude, elimina il progetto).

### Altre schermate
- **Nuovo progetto (`20`)**: solo il nome è obbligatorio. Descrizione in markdown, tag con suggerimenti, copertina, collegamenti, repository GitHub (con il file da usare come documentazione e l'opzione per mostrare i commit nel diario), fasi iniziali, stato iniziale.
- **Ricerca (`30`)**: filtri per tipo e progetto; risultati raggruppati (Task, Diario, Documentazione, Progetti) con il termine evidenziato (`--highlight-search`).
- **Impostazioni (`31`)**: menu a sinistra; sezioni Account (cambio password), Lingua, Collega Claude Code (stato, comandi da copiare, token mascherato con *Mostra / Copia / Rigenera…*), GitHub (token con *Verifica*, intervallo di sincronizzazione), Soglie di attività, File (scadenza degli screenshot, dimensione massima), Riconoscimento dei test (schemi di comando che fanno passare l'attività a «Claude esegue i test»).
- **Primo avvio (`40`)** e **Accesso (`41`)**: modulo centrato largo 340–400 px; l'accesso mostra lo stato di errore.

---

## 7. Stati (`50`–`56`)

- **Dashboard vuota (`50`)**: invito a creare il primo progetto e la lista «Per iniziare» (account ✓, collega Claude Code, collega GitHub).
- **Stati vuoti (`51`)**: diario, materiali, file, roadmap, ricerca senza risultati, nessuna proposta.
- **Caricamento ed errori (`52`)**:
  - segnaposto che hanno la stessa forma del contenuto;
  - avvisi per server che non risponde, token GitHub scaduto, Claude che non riesce a collegarsi (token rigenerato) e **modifica in conflitto** (Claude ha cambiato un elemento mentre lo modificavi: *Vedi le differenze / Tieni le mie*);
  - caricamento di file riuscito solo in parte (errore per ogni file, con *Riprova / Rimuovi*);
  - errori di validazione nei moduli e progetto non trovato.
- **Senza prossimo passo e nome lungo (`53`)**:
  - Il riquadro rosso «Nessun prossimo passo» sostituisce il prossimo passo: si sceglie un task aperto della fase (con un'opzione già selezionata), oppure si crea un task o si mette in pausa il progetto.
  - Sotto, «Dove eri rimasto» con l'ultima nota.
  - Il nome lungo va a capo nella testata e si tronca con i puntini nella barra laterale; la descrizione si ferma a due righe con *Mostra tutto*.
- **Molti progetti (`54`)**: vista Tabella (vedi sopra).
- **Diario lungo (`55`)**:
  - barra per saltare a un mese, con i conteggi;
  - la data del giorno resta in alto mentre scorri;
  - sessioni di Claude **riassunte** per impostazione (si può cambiare);
  - giorni vecchi chiusi, con il riepilogo e pallini per fonte;
  - *Carica i giorni precedenti* e salto al mese precedente.
- **Visualizzatore (`56`)**: vedi Componenti.

---

## 8. Telefono (`60`–`62`)

Il telefono è secondario: stesse informazioni, meno colonne.
- Barra in alto compatta (indietro o logo, titolo troncato, cerca, ⋯ o +). Le schede scorrono in orizzontale.
- Riquadri a tutta larghezza; azioni principali larghe tutta la riga o divise in due, alte almeno 40 px.
- Il percorso diventa verticale.
- Diario: filtri a chip che scorrono, voci compatte, barra fissa in basso per scrivere (allega, campo, *Invia*).
- Le barre laterali spariscono: i filtri della dashboard vanno in *Filtri ▾* e l'elenco dei progetti si raggiunge da indietro o dal logo.
- Punti di rottura consigliati: < 600 px layout telefono; 600–1000 px le barre laterali vanno sopra il contenuto (i mockup usano `flex-wrap`); > 1000 px layout completo.

---

## 9. Comportamenti da rispettare

- **Prossimo passo:** è sempre un solo task. Lo si cambia con *Imposta come prossimo* (roadmap), *Scegli un altro passo* (panoramica) o dalla selezione nel riquadro rosso. Con *Segna fatto* l'interfaccia propone come nuovo prossimo passo il task aperto successivo della fase, ma non lo sceglie da sola.
- **Avanzamento:** task chiusi / task totali. Il percorso e le barre a segmenti usano gli stessi dati.
- **Sessioni di Claude:** gli eventi con lo stesso id di sessione si raggruppano in un riquadro unico con orario di inizio e fine. Il riepilogo conta task, test, screenshot, cambi di stato e note.
- **Proposte:** non modificano nulla finché non vengono approvate. Una proposta rifiutata può portare una nota, che Claude legge. Il contatore viola è visibile nel menu della dashboard e nella pagina del progetto.
- **Test manuale:** l'esito (superato o fallito più la nota ed eventuali foto) diventa una voce del diario e cambia lo stato del progetto.
- **Documentazione da repository:** in sola lettura, sincronizzata all'intervallo scelto; *Sincronizza ora* forza l'aggiornamento.
- **Scadenza dei file:** gli screenshot di Claude non fissati si eliminano dopo N giorni (predefinito 90). Il visualizzatore mostra la data di eliminazione e *Fissa* la annulla.
- **Lingue:** IT/EN. Nessuna larghezza fissa sulle etichette; i bottoni crescono col testo; le righe vanno a capo (`flex-wrap`). Date relative («3 giorni fa», «adesso»), con la data completa al passaggio del mouse.
- **Accessibilità:** bottoni e link veri (niente `div` cliccabili), `aria-label` sui bottoni con sola icona, `role="dialog"` per il visualizzatore e Esc per chiuderlo, tutto usabile da tastiera (anche il riordino delle fasi: offri *Sposta su / giù* nel menu ⋯ in alternativa al trascinamento). Lo stato non è mai indicato solo dal colore: c'è sempre anche il testo.
