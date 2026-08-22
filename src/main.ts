import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  const heading = document.createElement('h1');
  heading.textContent = 'Mega Tetris';
  app.append(heading);
}
