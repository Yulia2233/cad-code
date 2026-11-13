import unittest
from notebook_adapter import adapt

class IdentityAdapterTests(unittest.TestCase):
    def test_preserve_geometry_and_unicode(self):
        source='import simplecadapi as scad\n# 圆柱\nbody=scad.make_cylinder_rsolid(radius=2, height=5)\nmodel = scad.Part(part_id="model", body=body)\n'
        result, changes=adapt(source)
        self.assertEqual(result,source.replace('part_id="model"','part_id=scad.notebook_id()'))
        self.assertEqual(len(changes),1)
        self.assertEqual(adapt(result),(result,[]))
    def test_unsupported_dynamic_identity_is_explicit(self):
        with self.assertRaisesRegex(ValueError,'Unsupported product ID'):
            adapt('model=scad.Part(part_id=variable, body=body)')
    def test_multiple_products_rejected(self):
        with self.assertRaisesRegex(ValueError,'Exactly one'):
            adapt('a=scad.Part(part_id="a",body=x)\nb=scad.Part(part_id="b",body=y)')
    def test_controller_connectors_are_inserted_after_part_identity(self):
        source='''import simplecadapi as scad
@app.cell
def _():
    model = scad.Part(part_id="model", body=body)
    return (model,)
'''
        result, changes = adapt(source, [{
            'connector_id': 'static_anchor',
            'placement': {'origin': [1,2,3], 'x_axis': [1,0,0], 'y_axis': [0,1,0]},
        }])
        self.assertIn('part_id=scad.notebook_id()', result)
        self.assertIn('scad.add_connector_rpart(', result)
        self.assertIn('connector_id="static_anchor"', result)
        self.assertLess(result.index('scad.make_part_rpart('), result.index('scad.add_connector_rpart('))
        self.assertEqual(changes[1]['replacement'], 'scad.make_part_rpart')
        self.assertEqual(changes[-1]['connectors_added'], 1)
    def test_connector_frames_reject_invalid_values(self):
        with self.assertRaisesRegex(ValueError, 'finite'):
            adapt('model=scad.Part(part_id="model", body=body)', [{
                'connector_id': 'bad', 'placement': {'origin': [float('nan'),0,0], 'x_axis': [1,0,0], 'y_axis': [0,1,0]},
            }])

if __name__=='__main__':unittest.main()
