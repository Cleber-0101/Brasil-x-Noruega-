CONEXÃO V13

O arquivo js/config.js já aponta para a URL /exec da implantação Web App atual:
https://script.google.com/macros/s/AKfycbwmWz7wwl22droTZPiyf8vd7oqFXlTZtB0IHVyWq1oY5L9ZPiUfcCmsx4H-DK8LTD4Y/exec

O front-end conversa somente com a URL /exec.

Após atualizar backend/Code.gs, publique uma nova versão da implantação Web App e publique a pasta docs completa no GitHub Pages. Os scripts usam ?v=13 para evitar JavaScript antigo em cache.
