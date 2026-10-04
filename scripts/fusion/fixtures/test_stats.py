import unittest
from stats import mean, moving_average

class StatsTests(unittest.TestCase):
    def test_mean_list(self):
        self.assertEqual(mean([1, 2, 3]), 2)
    def test_mean_generator(self):
        self.assertEqual(mean(x for x in [2, 4]), 3)
    def test_empty(self):
        with self.assertRaises(ValueError):
            mean([])
    def test_complete_windows(self):
        self.assertEqual(moving_average([1, 2, 3, 4], 2), [1.5, 2.5, 3.5])
    def test_invalid_window(self):
        with self.assertRaises(ValueError):
            moving_average([1, 2], 0)
    def test_short_series(self):
        self.assertEqual(moving_average([1], 2), [])

if __name__ == '__main__':
    unittest.main()
