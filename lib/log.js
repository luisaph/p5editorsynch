import chalk from "chalk";

/**
 * Centralized logging utilities with colored output and emojis
 * - Uses different colors and emojis for different log types
 * - Makes important actions (like deletions) more visible
 * - Makes routine actions (like skipping) less prominent
 */
const log = {
  info: (message) => console.log(chalk.blue(`ℹ️  ${message}`)),
  success: (message) => console.log(chalk.green(`✅ ${message}`)),
  warning: (message) => console.log(chalk.yellow(`⚠️  ${message}`)),
  error: (message) => console.log(chalk.red(`❌ ${message}`)),
  danger: (message) => console.log(chalk.red.bold(`🔥 ${message}`)),
  upload: (message) => console.log(chalk.magenta(`📤 ${message}`)),
  download: (message) => console.log(chalk.cyan(`📥 ${message}`)),
  skip: (message) => console.log(chalk.gray(`⏭️  ${message}`)),
  delete: (message) => console.log(chalk.red.bold(`🗑️  ${message}`)),
};

export default log;
