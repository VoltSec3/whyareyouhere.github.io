class TripleTriadGame {
    constructor() {
        this.board = Array(9).fill(null);
        this.currentPlayer = 'player';
        this.selectedCard = null;
        this.playerHand = [];
        this.opponentHand = [];
        this.gameOver = false;
        this.draggedCard = null;
        this.draggedCardIndex = null;
        this.hoveredCard = null;
        this.hoverTimeout = null;
        this.hoverReturnDelay = 500; // 0.5 seconds
        this.autoReplayDelay = 2000; // 2 seconds for auto-replay
        this.autoReplayTimeout = null;
        
        this.cardDatabase = [
            { id: 1, name: 'Ifrit', level: 1, top: 6, bottom: 2, left: 3, right: 5 },
            { id: 2, name: 'Shiva', level: 1, top: 5, bottom: 3, left: 2, right: 6 },
            { id: 3, name: 'Ramuh', level: 1, top: 4, bottom: 4, left: 4, right: 4 },
            { id: 4, name: 'Siren', level: 1, top: 3, bottom: 5, left: 6, right: 2 },
            { id: 5, name: 'Diablos', level: 2, top: 7, bottom: 3, left: 4, right: 6 },
            { id: 6, name: 'Carbuncle', level: 2, top: 5, bottom: 5, left: 3, right: 7 },
            { id: 7, name: 'Leviathan', level: 2, top: 6, bottom: 4, left: 7, right: 3 },
            { id: 8, name: 'Pandemona', level: 2, top: 8, bottom: 2, left: 5, right: 5 },
            { id: 9, name: 'Cerberus', level: 3, top: 7, bottom: 5, left: 6, right: 6 },
            { id: 10, name: 'Alexander', level: 3, top: 8, bottom: 4, left: 7, right: 5 },
            { id: 11, name: 'Phoenix', level: 3, top: 6, bottom: 8, left: 4, right: 7 },
            { id: 12, name: 'Bahamut', level: 4, top: 9, bottom: 6, left: 8, right: 7 },
            { id: 13, name: 'Tonberry', level: 1, top: 2, bottom: 7, left: 3, right: 4 },
            { id: 14, name: 'Cactuar', level: 1, top: 1, bottom: 8, left: 1, right: 8 },
            { id: 15, name: 'Malboro', level: 2, top: 6, bottom: 3, left: 7, right: 4 },
            { id: 16, name: 'R. Dragon', level: 3, top: 7, bottom: 7, left: 5, right: 5 }
        ];
        
        this.initializeGame();
    }
    
    initializeGame() {
        this.createBoard();
        this.dealCards();
        this.updateDisplay();
        this.bindEvents();
    }
    
    createBoard() {
        const boardElement = document.getElementById('gameBoard');
        boardElement.innerHTML = '';
        
        for (let i = 0; i < 9; i++) {
            const slot = document.createElement('div');
            slot.className = 'board-slot';
            slot.dataset.position = i;
            
            slot.addEventListener('dragover', (e) => this.handleDragOver(e));
            slot.addEventListener('drop', (e) => this.handleDrop(e));
            slot.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            
            boardElement.appendChild(slot);
        }
    }
    
    dealCards() {
        const shuffledCards = [...this.cardDatabase].sort(() => Math.random() - 0.5);
        this.playerHand = shuffledCards.slice(0, 5).map(card => ({ ...card, owner: 'player' }));
        this.opponentHand = shuffledCards.slice(5, 10).map(card => ({ ...card, owner: 'opponent' }));
    }
    
    bindEvents() {
        // Remove old click-based events since we're using drag and drop
    }
    
    handleDragStart(e, card) {
        if (this.gameOver || this.currentPlayer !== 'player') {
            e.preventDefault();
            return;
        }
        
        this.draggedCard = card;
        this.draggedCardIndex = this.playerHand.indexOf(card);
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }
    
    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.board-slot').forEach(slot => {
            slot.classList.remove('drag-over');
        });
    }
    
    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        
        const slot = e.target.closest('.board-slot');
        if (slot && this.board[slot.dataset.position] === null) {
            slot.classList.add('drag-over');
        }
    }
    
    handleDragLeave(e) {
        const slot = e.target.closest('.board-slot');
        if (slot) {
            slot.classList.remove('drag-over');
        }
    }
    
    handleDrop(e) {
        e.preventDefault();
        
        const slot = e.target.closest('.board-slot');
        if (!slot) return;
        
        const position = parseInt(slot.dataset.position);
        slot.classList.remove('drag-over');
        
        if (this.board[position] !== null) {
            this.showMessage('This position is already occupied!');
            return;
        }
        
        if (this.draggedCard && this.currentPlayer === 'player') {
            this.playCard(position, this.draggedCardIndex);
        }
        
        this.draggedCard = null;
        this.draggedCardIndex = null;
    }
    
    selectCard(cardIndex) {
        this.selectedCard = cardIndex;
        this.updateDisplay();
    }
    
    playCard(position, cardIndex = null) {
        if (this.board[position] !== null) {
            this.showMessage('This position is already occupied!');
            return;
        }
        
        let card;
        if (this.currentPlayer === 'player' && cardIndex !== null) {
            card = this.playerHand[cardIndex];
            this.board[position] = { ...card, position };
            this.playerHand.splice(cardIndex, 1);
        } else if (this.currentPlayer === 'opponent') {
            card = this.opponentHand[cardIndex];
            this.board[position] = { ...card, position };
            this.opponentHand.splice(cardIndex, 1);
        }
        
        this.checkForFlips(position);
        this.updateDisplay();
        
        if (this.checkGameOver()) {
            return;
        }
        
        // Only switch turns if current player was 'player'
        if (this.currentPlayer === 'player') {
            this.currentPlayer = 'opponent';
            this.showMessage('Opponent is thinking...');
            setTimeout(() => this.opponentTurn(), 1500);
        } else {
            this.currentPlayer = 'player';
            this.showMessage('Your turn - Drag a card to the board');
        }
    }
    
    opponentTurn() {
        if (this.gameOver) return;
        
        const availablePositions = this.board
            .map((card, index) => card === null ? index : null)
            .filter(index => index !== null);
        
        if (availablePositions.length === 0) return;
        
        const randomPosition = availablePositions[Math.floor(Math.random() * availablePositions.length)];
        const randomCardIndex = Math.floor(Math.random() * this.opponentHand.length);
        
        this.playCard(randomPosition, randomCardIndex);
    }
    
    checkForFlips(position) {
        const card = this.board[position];
        const adjacentPositions = this.getAdjacentPositions(position);
        
        adjacentPositions.forEach(adjPos => {
            const adjacentCard = this.board[adjPos];
            if (adjacentCard && adjacentCard.owner !== card.owner) {
                if (this.shouldFlip(card, adjacentCard, position, adjPos)) {
                    this.board[adjPos] = { ...adjacentCard, owner: card.owner };
                }
            }
        });
    }
    
    getAdjacentPositions(position) {
        const adjacent = [];
        const row = Math.floor(position / 3);
        const col = position % 3;
        
        if (row > 0) adjacent.push(position - 3); // top
        if (row < 2) adjacent.push(position + 3); // bottom
        if (col > 0) adjacent.push(position - 1); // left
        if (col < 2) adjacent.push(position + 1); // right
        
        return adjacent;
    }
    
    shouldFlip(card, adjacentCard, position, adjacentPosition) {
        const row = Math.floor(position / 3);
        const col = position % 3;
        const adjRow = Math.floor(adjacentPosition / 3);
        const adjCol = adjacentPosition % 3;
        
        if (row === adjRow - 1) return card.bottom > adjacentCard.top; // card is above adjacent
        if (row === adjRow + 1) return card.top > adjacentCard.bottom; // card is below adjacent
        if (col === adjCol - 1) return card.right > adjacentCard.left; // card is left of adjacent
        if (col === adjCol + 1) return card.left > adjacentCard.right; // card is right of adjacent
        
        return false;
    }
    
    checkGameOver() {
        const filledSlots = this.board.filter(card => card !== null).length;
        if (filledSlots === 9) {
            this.gameOver = true;
            this.calculateFinalScore();
            return true;
        }
        return false;
    }
    
    calculateFinalScore() {
        const playerCards = this.board.filter(card => card && card.owner === 'player').length;
        const opponentCards = this.board.filter(card => card && card.owner === 'opponent').length;
        
        document.getElementById('playerScore').textContent = playerCards;
        document.getElementById('opponentScore').textContent = opponentCards;
        
        if (playerCards > opponentCards) {
            this.showMessage('You Win! 🎉');
        } else if (opponentCards > playerCards) {
            this.showMessage('You Lose! 😔');
        } else {
            this.showMessage('It\'s a Draw! 🤝');
        }
        
        // Auto-replay after 2 seconds
        this.clearAutoReplayTimeout();
        this.autoReplayTimeout = setTimeout(() => {
            this.resetGame();
            this.showMessage('Game Reset - Auto-restarting...');
        }, this.autoReplayDelay);
    }
    
    resetGame() {
        this.board = Array(9).fill(null);
        this.currentPlayer = 'player';
        this.selectedCard = null;
        this.playerHand = [];
        this.opponentHand = [];
        this.gameOver = false;
        this.draggedCard = null;
        this.draggedCardIndex = null;
        this.hoveredCard = null;
        
        this.clearAutoReplayTimeout();
        this.dealCards();
        this.updateDisplay();
        this.showMessage('New game started!');
    }
    
    clearAutoReplayTimeout() {
        if (this.autoReplayTimeout) {
            clearTimeout(this.autoReplayTimeout);
            this.autoReplayTimeout = null;
        }
    }
    
    updateDisplay() {
        this.updateBoard();
        this.updateHands();
        this.updateScore();
    }
    
    updateBoard() {
        const slots = document.querySelectorAll('.board-slot');
        slots.forEach((slot, index) => {
            slot.innerHTML = '';
            const card = this.board[index];
            if (card) {
                slot.appendChild(this.createCardElement(card));
            }
        });
    }
    
    updateHands() {
        const playerHandElement = document.getElementById('playerHand');
        const opponentHandElement = document.getElementById('opponentHand');
        
        playerHandElement.innerHTML = '';
        opponentHandElement.innerHTML = '';
        
        this.playerHand.forEach((card, index) => {
            const cardElement = this.createCardElement(card, true);
            cardElement.classList.add('hand-card');
            playerHandElement.appendChild(cardElement);
        });
        
        this.opponentHand.forEach((card) => {
            const cardElement = this.createCardElement(card, false);
            cardElement.classList.add('hand-card');
            opponentHandElement.appendChild(cardElement);
        });
    }
    
    createCardElement(card, isDraggable = false) {
        const cardDiv = document.createElement('div');
        cardDiv.className = `card ${card.owner}`;
        cardDiv.draggable = isDraggable && card.owner === 'player';
        
        if (isDraggable && card.owner === 'player') {
            cardDiv.addEventListener('dragstart', (e) => this.handleDragStart(e, card));
            cardDiv.addEventListener('dragend', (e) => this.handleDragEnd(e));
            cardDiv.addEventListener('mouseenter', (e) => this.handleCardHover(e, card));
            cardDiv.addEventListener('mouseleave', (e) => this.handleCardLeave(e, card));
        } else if (card.owner === 'opponent') {
            cardDiv.addEventListener('mouseenter', (e) => this.handleCardHover(e, card));
            cardDiv.addEventListener('mouseleave', (e) => this.handleCardLeave(e, card));
        }
        
        cardDiv.innerHTML = `
            <div class="card-stats">
                <div class="stat top">${card.top}</div>
                <div class="stat left">${card.left}</div>
                <div class="stat right">${card.right}</div>
                <div class="stat bottom">${card.bottom}</div>
            </div>
            <div class="card-name">${card.name}</div>
        `;
        
        return cardDiv;
    }
    
    handleCardHover(e, card) {
        if (this.gameOver || this.currentPlayer !== 'player') return;
        
        this.clearHoverTimeout();
        
        if (this.hoveredCard && this.hoveredCard !== card) {
            this.hoveredCard.classList.remove('expanded');
        }
        
        this.hoveredCard = e.target.closest('.hand-card');
        this.hoveredCard.classList.add('expanded');
    }
    
    handleCardLeave(e, card) {
        this.clearHoverTimeout();
        this.hoverTimeout = setTimeout(() => {
            if (this.hoveredCard) {
                this.hoveredCard.classList.remove('expanded');
                this.hoveredCard = null;
            }
        }, this.hoverReturnDelay);
    }
    
    clearHoverTimeout() {
        if (this.hoverTimeout) {
            clearTimeout(this.hoverTimeout);
            this.hoverTimeout = null;
        }
    }
    
    updateScore() {
        const playerCards = this.board.filter(card => card && card.owner === 'player').length;
        const opponentCards = this.board.filter(card => card && card.owner === 'opponent').length;
        
        document.getElementById('playerScore').textContent = playerCards;
        document.getElementById('opponentScore').textContent = opponentCards;
    }
    
    updateTurnIndicator() {
        // Removed - using message instead
    }
    
    showMessage(message) {
        // Message element removed - do nothing
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const game = new TripleTriadGame();
    // Initial message removed - no message element
    
    // Play background music
    const bgMusic = document.getElementById('bgMusic');
    if (bgMusic) {
        bgMusic.volume = 0.3; // Set volume to 30%
        bgMusic.play().catch(e => console.log('Audio play failed:', e));
    }
});
