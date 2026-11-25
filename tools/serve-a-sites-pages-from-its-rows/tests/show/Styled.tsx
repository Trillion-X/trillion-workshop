// A test part with its own CSS module, as the shared marketing parts have: the page must carry its local class and rule.
import React from 'react';
import styles from './styled.module.css';
import { Text } from '../../../ui/show/text/Text.tsx';

export function View({ words }: { words: string }) {
  return <Text className={styles.box}>{words}</Text>;
}
